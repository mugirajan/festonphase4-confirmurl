'use strict';

/**
 * Tells an engineer what Feston decided about their points claim (2026-10-26).
 *
 * Photo rewards are paid on upload, so the only decisions Feston takes on them
 * are after the fact: a take-back of points already paid, or a rejection of a
 * claim still waiting in the old reviewed queue. Both happened silently for the
 * engineer — the balance moved and the bell said nothing. Now the portal calls
 * `?action=claim-notify` with the claim id after it records the decision, and
 * a row lands in `installer_notifications`, the same feed the points split
 * credits use, so the bell on the installer home screen lights up.
 *
 * The message is composed HERE from the claim document, not sent by the
 * portal: the service verifies the caller is Feston staff, reads what was
 * actually decided, and writes one notification per decision (a fixed id, so
 * a retried call cannot post twice).
 */

const { NOTIFICATIONS_COLLECTION } = require('./points-split');

const CLAIMS_COLLECTION = 'points_claims';

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const reply = (status, body) => ({ status, body });

/** The signed-in caller's uid, or null. */
async function callerUid({ verifyIdToken, authorization, logger }) {
    const bearer = /^Bearer\s+(.+)$/i.exec(str(authorization));
    if (!bearer) return null;
    try {
        return (await verifyIdToken(bearer[1])).uid || null;
    } catch (error) {
        if (logger) logger.warn('claim-notify: bad token', { error: String(error && error.message) });
        return null;
    }
}

/**
 * Feston staff: an `admins` record that is not a company admin. A company
 * admin cannot decide claims in the portal, so they cannot announce one here.
 */
async function festonStaff(firestore, uid) {
    const snap = await firestore.collection('admins').doc(uid).get();
    if (!snap.exists) return false;
    const role = str((snap.data() || {}).role).toLowerCase();
    return role !== 'company-admin';
}

/** The notification for a decided claim, or null when the claim is still open. */
function compose(claim) {
    const status = str(claim.status).toLowerCase();
    const label = str(claim.label) || str(claim.action) || 'Points claim';
    const customer = str(claim.customerName) || str(claim.subjectLabel);
    const serial = str(claim.serialnumber);
    const about = [customer ? `for ${customer}` : '', serial ? `(SN ${serial})` : ''].filter(Boolean).join(' ');
    const reason = str(claim.decisionMessage);
    const points = Math.round(Number(claim.awardedPoints)) || Math.round(Number(claim.points)) || 0;

    if (status === 'rejected') {
        // A take-back shows how much went; a never-paid claim has nothing to quote.
        const taken = Math.round(Number(claim.revokedPoints)) || 0;
        const title = taken > 0 ? `${taken} points taken back` : 'Points claim not approved';
        const what = taken > 0
            ? `Feston reviewed your "${label}" photo ${about} and took back the ${taken} points it had earned.`
            : `Feston did not approve your "${label}" claim ${about}.`;
        return {
            kind: 'claim-rejected',
            title,
            message: `${what}${reason ? ` Reason: ${reason}` : ''}`.replace(/\s+/g, ' ').trim(),
            points: taken,
        };
    }
    if (status === 'approved') {
        return {
            kind: 'claim-approved',
            title: `${points} points credited`,
            message: `Feston approved your "${label}" claim ${about}.${reason ? ` ${reason}` : ''}`.replace(/\s+/g, ' ').trim(),
            points,
        };
    }
    return null;
}

/**
 * body: { claimId }
 *
 * Writes `installer_notifications/claim_<status>_<claimId>` for the engineer
 * who filed the claim. Idempotent on that id.
 */
async function notifyClaimDecision({ firestore, verifyIdToken, authorization, body, now, logger }) {
    const uid = await callerUid({ verifyIdToken, authorization, logger });
    if (!uid) return reply(401, { status: 'unauthenticated' });
    if (!(await festonStaff(firestore, uid))) return reply(403, { status: 'forbidden' });

    const claimId = str(body && body.claimId);
    if (!claimId) return reply(400, { status: 'bad-request', message: 'Missing claim.' });

    const snap = await firestore.collection(CLAIMS_COLLECTION).doc(claimId).get();
    if (!snap.exists) return reply(404, { status: 'not-found' });
    const claim = snap.data() || {};
    const installerUid = str(claim.installerId);
    if (!installerUid) return reply(422, { status: 'no-installer', message: 'This claim names no engineer.' });

    const note = compose(claim);
    if (!note) return reply(409, { status: 'undecided', message: 'This claim has not been decided.' });

    const id = `claim_${note.kind.replace('claim-', '')}_${claimId}`;
    await firestore.collection(NOTIFICATIONS_COLLECTION).doc(id).set({
        installerUid,
        kind: note.kind,
        title: note.title,
        message: note.message,
        points: note.points,
        registrationId: str(claim.registrationId),
        claimId,
        read: false,
        createdAt: now(),
    });
    return reply(200, { status: 'ok', id });
}

module.exports = { notifyClaimDecision, compose };
