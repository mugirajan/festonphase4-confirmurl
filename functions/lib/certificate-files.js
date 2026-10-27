'use strict';

/**
 * One issued certificate file, for whoever is entitled to it (2026-10-27).
 *
 * The confirm service renders a registration's warranty certificate and test
 * report once, from the app's own certificate (lib/warranty-certificate.js,
 * lib/test-report.js), and emails them to the customer. Those files are THE
 * certificate: the app, the customer's email, the company admin's page and
 * the staff portal must all hand out the same bytes, never a look-alike drawn
 * somewhere else. `warranty_certificates` and `test_reports` are not readable
 * by clients, so every surface fetches the file through here.
 *
 * Who may read a registration's file:
 *   customer       — the registration is theirs (`userId`)
 *   company admin  — the registration is their company's (`companyId`)
 *   Feston staff   — any `admins` record that is not a company admin
 *
 * The registration is named by id, or by serial number for the staff pages
 * that work from a serial. `variant` is `pdf` (default) or `png`, the latter
 * only for the warranty certificate, whose render keeps a PNG for previews.
 */

const { REGISTRATIONS_COLLECTION, WARRANTY_COLLECTION, TEST_REPORT_COLLECTION } = require('./config');
const { warrantyFilename } = require('./warranty-certificate');
const { testReportFilename } = require('./test-report');

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const reply = (status, body) => ({ status, body });

const isIssued = (rec) => !!(rec && str(rec.status) === 'ready' && str(rec.pdfPath));

/** `{ uid, role: 'staff' | 'company' | 'customer', companyId }` or `{ error }`. */
async function callerFrom({ firestore, verifyIdToken, authorization, logger }) {
    const bearer = /^Bearer\s+(.+)$/i.exec(str(authorization));
    if (!bearer) return { error: reply(401, { status: 'unauthenticated' }) };
    let uid;
    try {
        uid = str((await verifyIdToken(bearer[1])).uid);
    } catch (error) {
        if (logger) logger.warn('certificate-file: bad token', { error: String(error && error.message) });
        return { error: reply(401, { status: 'unauthenticated' }) };
    }
    if (!uid) return { error: reply(401, { status: 'unauthenticated' }) };

    const adminSnap = await firestore.collection('admins').doc(uid).get();
    if (!adminSnap.exists) return { uid, role: 'customer', companyId: '' };
    const a = adminSnap.data() || {};
    if (str(a.role).toLowerCase() === 'company-admin') {
        const companyId = str(a.companyId);
        if (!companyId) return { error: reply(403, { status: 'forbidden' }) };
        return { uid, role: 'company', companyId };
    }
    return { uid, role: 'staff', companyId: '' };
}

/** The registration by id, else the first with this serial; `{ id, data }` or null. */
async function findRegistration(firestore, registrationId, serialnumber) {
    const id = str(registrationId);
    if (id) {
        const snap = await firestore.collection(REGISTRATIONS_COLLECTION).doc(id).get();
        return snap.exists ? { id: snap.id, data: snap.data() || {} } : null;
    }
    const serial = str(serialnumber);
    if (!serial) return null;
    const q = await firestore.collection(REGISTRATIONS_COLLECTION).where('serialnumber', '==', serial).limit(1).get();
    const d = q.docs[0];
    return d ? { id: d.id, data: d.data() || {} } : null;
}

/**
 * Resolves to `{ status, body }` on refusal, or `{ status: 200, file }` with
 * `file = { bytes, contentType, filename }` for the caller to stream.
 * `readObject(path)` returns a Storage object's bytes (injected for the tests).
 */
async function certificateFile({
    firestore,
    verifyIdToken,
    authorization,
    registrationId,
    serialnumber,
    kind,
    variant,
    readObject,
    logger,
}) {
    const who = await callerFrom({ firestore, verifyIdToken, authorization, logger });
    if (who.error) return who.error;

    const which = str(kind).toLowerCase();
    const ext = str(variant).toLowerCase() || 'pdf';
    if ((which !== 'warranty' && which !== 'test') || (ext !== 'pdf' && ext !== 'png')) {
        return reply(400, { status: 'bad-request' });
    }
    if (ext === 'png' && which !== 'warranty') return reply(400, { status: 'bad-request' });

    const reg = await findRegistration(firestore, registrationId, serialnumber);
    if (!reg) return reply(404, { status: 'not-found' });
    const allowed =
        who.role === 'staff' ||
        (who.role === 'company' && str(reg.data.companyId) === who.companyId) ||
        (who.role === 'customer' && str(reg.data.userId) === who.uid);
    // Not "forbidden": whether a registration exists is not the caller's business either.
    if (!allowed) return reply(404, { status: 'not-found' });

    const recSnap = await firestore
        .collection(which === 'warranty' ? WARRANTY_COLLECTION : TEST_REPORT_COLLECTION)
        .doc(reg.id)
        .get();
    const rec = recSnap.exists ? recSnap.data() || {} : null;
    if (!isIssued(rec)) return reply(404, { status: 'not-issued' });
    const path = ext === 'png' ? str(rec.pngPath) : str(rec.pdfPath);
    if (!path) return reply(404, { status: 'not-issued' });

    const serial = str(rec.serialnumber) || str(reg.data.serialnumber) || str(reg.data.Serialnumber);
    const pdfName = which === 'warranty' ? warrantyFilename(serial) : testReportFilename(serial);
    const bytes = await readObject(path);
    return {
        status: 200,
        file: {
            bytes,
            contentType: ext === 'png' ? 'image/png' : 'application/pdf',
            filename: ext === 'png' ? pdfName.replace(/\.pdf$/i, '.png') : pdfName,
        },
    };
}

module.exports = { certificateFile, isIssued, callerFrom };
