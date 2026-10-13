'use strict';

/**
 * Installer customer lookup — `POST ?action=lookup-customer`.
 *
 * Why this lives in the confirm function rather than its own: since the
 * 2026-09-27 Firestore rules rewrite the mobile app may not read `users`, so
 * an installer typing a repeat customer's phone number got "You don't have
 * access" and could not continue. The right home is a dedicated Cloud
 * Function, but a NEW function cannot be made publicly invokable by the
 * account that deploys here (it lacks `cloudfunctions.functions.setIamPolicy`
 * — the same reason `createInstallerLogin`, `awardPoints` and `redeemPoints`
 * have never shipped). `confirm` is already public and already deployed, so
 * the endpoint rides on it. Move it out the day that permission exists.
 *
 * What it guards: the caller must present a Firebase ID token (verified
 * here, never trusted from the body) AND that uid must belong to an active
 * installer row — under either keying convention, see `findInstallerByUid`.
 * A customer, an anonymous caller or a deactivated engineer gets 403 and
 * learns nothing. What it returns: the one customer whose phone matches,
 * with the fields the register wizard pre-fills — no more.
 */

const PHONE_FIELD = 'phone';

function last10(v) {
    return String(v || '').replace(/\D/g, '').slice(-10);
}

const str = (v) => (typeof v === 'string' ? v : '');

/** The installer row for a uid: keyed by uid (app-provisioned) or carrying it in a field (portal-provisioned). */
async function findInstallerByUid(firestore, uid) {
    const direct = await firestore.collection('installers').doc(uid).get();
    if (direct.exists) return direct;
    const byUid = await firestore.collection('installers').where('uid', '==', uid).limit(1).get();
    return byUid.empty ? null : byUid.docs[0];
}

/**
 * @returns {{status: number, body: object}} — ready to send.
 */
async function lookupCustomerForInstaller({ firestore, verifyIdToken, authorization, phone, logger }) {
    const bearer = /^Bearer\s+(.+)$/i.exec(str(authorization) || '');
    if (!bearer) return { status: 401, body: { status: 'unauthenticated' } };

    let uid = '';
    try {
        const decoded = await verifyIdToken(bearer[1]);
        uid = str(decoded && decoded.uid);
    } catch (error) {
        if (logger) logger.warn('lookup-customer: token verification failed', error);
    }
    if (!uid) return { status: 401, body: { status: 'unauthenticated' } };

    const installer = await findInstallerByUid(firestore, uid);
    if (!installer || (installer.data() || {}).active === false) {
        return { status: 403, body: { status: 'not-installer' } };
    }

    const national = last10(phone);
    if (national.length < 7) return { status: 400, body: { status: 'bad-phone' } };

    // The two apps never agreed on a stored format; match all three.
    for (const candidate of [national, `+91${national}`, `91${national}`]) {
        const snap = await firestore.collection('users').where(PHONE_FIELD, '==', candidate).limit(1).get();
        if (snap.empty) continue;
        const d = snap.docs[0];
        const u = d.data() || {};
        return {
            status: 200,
            body: {
                status: 'found',
                customer: {
                    uid: d.id,
                    name: str(u.name) || str(u.username),
                    email: str(u.email),
                    phone: str(u.phone),
                    city: str(u.city),
                    address: str(u.address),
                },
            },
        };
    }
    return { status: 200, body: { status: 'not-found' } };
}

module.exports = { lookupCustomerForInstaller, findInstallerByUid };
