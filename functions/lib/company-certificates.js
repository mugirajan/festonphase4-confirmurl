'use strict';

/**
 * The Solar Super Hero certificates of one company's customers, for the
 * company admin's Certificates page (2026-10-22).
 *
 * `hero_certificates/{uid}` is readable only by its customer and Feston staff,
 * so the portal cannot read it for a company admin. This returns just what the
 * page needs — the number and whether the files are ready — and only for
 * customers who have a registration of the caller's own company. With the
 * number, the page links to the existing public certificate page and files
 * (`?action=hero` / `?action=hero-file`), which are keyed by that number.
 */

const { REGISTRATIONS_COLLECTION, HERO_COLLECTION } = require('./config');

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const reply = (status, body) => ({ status, body });

async function listCompanyHeroCertificates({ firestore, verifyIdToken, authorization, logger }) {
    const bearer = /^Bearer\s+(.+)$/i.exec(str(authorization));
    if (!bearer) return reply(401, { status: 'unauthenticated' });
    let uid;
    try {
        uid = (await verifyIdToken(bearer[1])).uid;
    } catch (error) {
        if (logger) logger.warn('company-heroes: bad token', { error: String(error && error.message) });
        return reply(401, { status: 'unauthenticated' });
    }

    const adminSnap = await firestore.collection('admins').doc(uid).get();
    const a = adminSnap.exists ? adminSnap.data() || {} : {};
    const companyId = str(a.companyId);
    if (str(a.role).toLowerCase() !== 'company-admin' || !companyId) return reply(403, { status: 'forbidden' });

    const regs = await firestore.collection(REGISTRATIONS_COLLECTION).where('companyId', '==', companyId).limit(1000).get();
    const uids = Array.from(new Set(regs.docs.map((d) => str((d.data() || {}).userId)).filter(Boolean)));

    const heroes = {};
    for (let i = 0; i < uids.length; i += 100) {
        const refs = uids.slice(i, i + 100).map((u) => firestore.collection(HERO_COLLECTION).doc(u));
        const snaps = refs.length ? await firestore.getAll(...refs) : [];
        for (const s of snaps) {
            if (!s.exists) continue;
            const h = s.data() || {};
            const number = str(h.certificateNumber);
            if (number) heroes[s.id] = { certificateNumber: number, status: str(h.status) || 'rendering' };
        }
    }
    return reply(200, { status: 'ok', heroes });
}

module.exports = { listCompanyHeroCertificates };
