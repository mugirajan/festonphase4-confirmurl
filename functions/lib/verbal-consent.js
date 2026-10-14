'use strict';

/**
 * Verbal-consent fallback (proposal slide 13).
 *
 * Some customers cannot use the confirmation link: no smartphone, no data, or
 * they cannot read the page. The engineer asks for a callback from the app
 * (`consent_callbacks/{id}`), Feston support phones the customer, reads the
 * registration out, and records what was said. If the customer consented,
 * the registration completes here exactly as a link confirmation would —
 * warranty, points, certificate — with `consentMethod: 'verbal'` and who
 * recorded it stamped on the row instead of an OTP.
 *
 * Who may call this: Feston STAFF, proven by their ID token and their
 * `admins/{uid}` document. Not a company admin (the audited party must not
 * be able to confirm its own installs by phone), and never an engineer.
 *
 * The link's 48-hour expiry does not apply: a callback queue is slower than a
 * tap, and a staff member who has spoken to the customer is a stronger
 * assurance than a link opened in time. `ignoreExpiry` is passed for that
 * reason and for no other caller.
 */

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** admins/{uid}.role values that are Feston staff. Blank is a legacy admin. */
const STAFF_ROLES = new Set(['', 'admin', 'engineers', 'crm', 'regions-head', 'agents']);

const OUTCOMES = new Set(['consented', 'declined', 'unreachable']);

async function staffFromToken({ firestore, verifyIdToken, authorization, logger }) {
    const bearer = /^Bearer\s+(.+)$/i.exec(str(authorization));
    if (!bearer) return null;
    let uid = '';
    try {
        const decoded = await verifyIdToken(bearer[1]);
        uid = str(decoded && decoded.uid);
    } catch (error) {
        if (logger) logger.warn('verbal-consent: token verification failed', error);
        return null;
    }
    if (!uid) return null;
    const snap = await firestore.collection('admins').doc(uid).get();
    if (!snap.exists) return null;
    const d = snap.data() || {};
    const role = str(d.role).toLowerCase();
    if (!STAFF_ROLES.has(role)) return null;
    return { uid, name: str(d.name) || str(d.email) || uid, role };
}

/**
 * Records the outcome of a support call and, on consent, completes the
 * registration. `complete` is store.completeRegistration, injected so this
 * can be tested with a stub.
 */
async function recordVerbalConsent({ firestore, verifyIdToken, authorization, body, complete, userAgent, logger, now = () => new Date() }) {
    const staff = await staffFromToken({ firestore, verifyIdToken, authorization, logger });
    if (!staff) return { status: 403, body: { status: 'not-staff' } };

    const b = body && typeof body === 'object' ? body : {};
    const token = str(b.token);
    const outcome = str(b.outcome).toLowerCase();
    const note = str(b.note).slice(0, 1000);
    const callbackId = str(b.callbackId);
    if (!token) return { status: 400, body: { status: 'bad-request', message: 'token is required' } };
    if (!OUTCOMES.has(outcome)) return { status: 400, body: { status: 'bad-request', message: 'outcome must be consented, declined or unreachable' } };
    if (outcome !== 'unreachable' && note.length < 5) {
        return { status: 400, body: { status: 'bad-request', message: 'A note of what the customer said is required.' } };
    }

    const calledAt = now();
    const callbackRef = callbackId ? firestore.collection('consent_callbacks').doc(callbackId) : null;

    if (outcome !== 'consented') {
        if (callbackRef) {
            await callbackRef.set(
                {
                    status: outcome,
                    calledAt,
                    calledBy: staff.uid,
                    calledByName: staff.name,
                    note,
                    updatedAt: calledAt,
                },
                { merge: true },
            );
        }
        return { status: 200, body: { status: outcome } };
    }

    const result = await complete(token, {
        userAgent: str(userAgent),
        verifiedPhone: '',
        requirePhoneMatch: false,
        ignoreExpiry: true,
        acknowledgements: {
            acceptedTerms: true,
            acceptedDataForTraining: true,
            // Asked separately on the call; optional, as on the confirm page.
            acceptedMarketing: b.marketingConsent === true,
            consentMethod: 'verbal',
            consentRecordedBy: staff.uid,
            consentRecordedByName: staff.name,
            consentNote: note,
            consentCalledAt: calledAt,
            consentRecordingRef: str(b.recordingRef).slice(0, 300),
        },
    });

    if (result.status !== 'completed') {
        const code = result.status === 'not-found' ? 404 : result.status === 'cancelled' ? 409 : 422;
        return { status: code, body: { status: result.status, reason: result.reason || '' } };
    }

    if (callbackRef) {
        await callbackRef.set(
            {
                status: 'completed',
                calledAt,
                calledBy: staff.uid,
                calledByName: staff.name,
                note,
                registeredProductId: result.registeredProductId,
                updatedAt: calledAt,
            },
            { merge: true },
        );
    }
    return {
        status: 200,
        body: {
            status: 'completed',
            registeredProductId: result.registeredProductId,
            alreadyCompleted: !!result.alreadyCompleted,
        },
    };
}

module.exports = { STAFF_ROLES, OUTCOMES, staffFromToken, recordVerbalConsent };
