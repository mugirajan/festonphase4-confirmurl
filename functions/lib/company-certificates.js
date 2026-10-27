'use strict';

/**
 * The certificates of one company's customers, for the company admin's
 * Certificates page (2026-10-22; issued files 2026-10-27).
 *
 * `hero_certificates/{uid}`, `warranty_certificates/{registrationId}` and
 * `test_reports/{registrationId}` are readable only by their customer and
 * Feston staff, so the portal cannot read them for a company admin. This
 * gives the page just what it needs, and only for registrations of
 * the caller's own company:
 *
 *   listCompanyHeroCertificates — the Super Hero number per customer (the page
 *     links to the public `?action=hero` / `?action=hero-file` by number), and
 *     which registrations have an ISSUED warranty certificate and test report.
 *
 *   The files themselves come from lib/certificate-files.js (`?action=
 *   certificate-file`), which serves the customer, the company admin and
 *   Feston staff alike — the one PDF the confirm service rendered from the
 *   app's own certificate and emailed. The page draws a certificate only for
 *   a registration that pre-dates issuing, which this reports as absent.
 */

const { REGISTRATIONS_COLLECTION, HERO_COLLECTION, WARRANTY_COLLECTION, TEST_REPORT_COLLECTION } = require('./config');

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const reply = (status, body) => ({ status, body });

/** The caller, if they are a company admin: `{ uid, companyId }`, else a reply to send. */
async function companyAdminFrom({ firestore, verifyIdToken, authorization, logger, what }) {
    const bearer = /^Bearer\s+(.+)$/i.exec(str(authorization));
    if (!bearer) return { error: reply(401, { status: 'unauthenticated' }) };
    let uid;
    try {
        uid = (await verifyIdToken(bearer[1])).uid;
    } catch (error) {
        if (logger) logger.warn(`${what}: bad token`, { error: String(error && error.message) });
        return { error: reply(401, { status: 'unauthenticated' }) };
    }

    const adminSnap = await firestore.collection('admins').doc(uid).get();
    const a = adminSnap.exists ? adminSnap.data() || {} : {};
    const companyId = str(a.companyId);
    if (str(a.role).toLowerCase() !== 'company-admin' || !companyId) return { error: reply(403, { status: 'forbidden' }) };
    return { uid, companyId };
}

/** `{ id: data }` for the docs of `collection` with these ids, read in batches of 100. */
async function readByIds(firestore, collection, ids) {
    const out = {};
    for (let i = 0; i < ids.length; i += 100) {
        const refs = ids.slice(i, i + 100).map((id) => firestore.collection(collection).doc(id));
        const snaps = refs.length ? await firestore.getAll(...refs) : [];
        for (const s of snaps) if (s.exists) out[s.id] = s.data() || {};
    }
    return out;
}

const { isIssued } = require('./certificate-files');

async function listCompanyHeroCertificates({ firestore, verifyIdToken, authorization, logger }) {
    const who = await companyAdminFrom({ firestore, verifyIdToken, authorization, logger, what: 'company-heroes' });
    if (who.error) return who.error;

    const regs = await firestore.collection(REGISTRATIONS_COLLECTION).where('companyId', '==', who.companyId).limit(1000).get();
    const uids = Array.from(new Set(regs.docs.map((d) => str((d.data() || {}).userId)).filter(Boolean)));
    const regIds = regs.docs.map((d) => d.id);

    const [heroDocs, warranties, reports] = await Promise.all([
        readByIds(firestore, HERO_COLLECTION, uids),
        readByIds(firestore, WARRANTY_COLLECTION, regIds),
        readByIds(firestore, TEST_REPORT_COLLECTION, regIds),
    ]);

    const heroes = {};
    for (const [uid, h] of Object.entries(heroDocs)) {
        const number = str(h.certificateNumber);
        if (number) heroes[uid] = { certificateNumber: number, status: str(h.status) || 'rendering' };
    }

    // Which registrations have issued files, so the page knows when it may
    // serve the customer's own document and when it has to draw one.
    const files = {};
    for (const id of regIds) {
        const warranty = isIssued(warranties[id]);
        const test = isIssued(reports[id]);
        if (warranty || test) files[id] = { warranty, test };
    }

    return reply(200, { status: 'ok', heroes, files });
}

module.exports = { listCompanyHeroCertificates };
