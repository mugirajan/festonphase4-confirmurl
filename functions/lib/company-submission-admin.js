'use strict';

/**
 * Company submissions for Feston staff (2026-10-27): list the companies
 * customers typed in, and record approve / reject / reopen.
 *
 * The portal reads `company_submissions` directly once the Firestore rule for
 * it is published. Until then (the test project today) it calls this action,
 * which runs with admin access and checks the caller itself: Feston staff
 * only, by ID token.
 */

const { callerFrom } = require('./certificate-files');

const COLLECTION = 'company_submissions';
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const reply = (status, body) => ({ status, body });

/** Fields the portal may set on a submission. Everything else is ignored. */
const PATCHABLE = ['status', 'companyId', 'rejectReason', 'reviewedBy', 'reviewedByName'];
const STATUSES = new Set(['pending', 'approved', 'rejected']);

const iso = (v) => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v || null);

function plain(id, data) {
    const out = { id };
    for (const [k, v] of Object.entries(data || {})) out[k] = iso(v);
    return out;
}

/**
 * `op` is `list` or `update` (`submissionId` + `patch`). Resolves to
 * `{ status, body }`; `body.items` for a list, `body.status: 'ok'` for an update.
 */
async function companySubmissionAction({ firestore, verifyIdToken, authorization, op, submissionId, patch, now, logger }) {
    const who = await callerFrom({ firestore, verifyIdToken, authorization, logger });
    if (who.error) return who.error;
    if (who.role !== 'staff') return reply(403, { status: 'forbidden' });

    if (op === 'list') {
        const snap = await firestore.collection(COLLECTION).limit(1000).get();
        return reply(200, { status: 'ok', items: snap.docs.map((d) => plain(d.id, d.data())) });
    }

    if (op === 'update') {
        const id = str(submissionId);
        if (!id) return reply(400, { status: 'invalid', message: 'submissionId is required.' });
        const fields = {};
        for (const k of PATCHABLE) if (patch && typeof patch[k] === 'string') fields[k] = patch[k].trim();
        if (fields.status && !STATUSES.has(fields.status)) return reply(400, { status: 'invalid', message: 'Unknown status.' });
        if (!Object.keys(fields).length) return reply(400, { status: 'invalid', message: 'Nothing to change.' });
        const ref = firestore.collection(COLLECTION).doc(id);
        if (!(await ref.get()).exists) return reply(404, { status: 'not-found' });
        const stamp = typeof now === 'function' ? now() : new Date();
        await ref.update({ ...fields, reviewedBy: fields.reviewedBy || who.uid, reviewedAt: stamp, updatedAt: stamp });
        return reply(200, { status: 'ok' });
    }

    return reply(400, { status: 'invalid', message: 'Unknown op.' });
}

module.exports = { companySubmissionAction, PATCHABLE };
