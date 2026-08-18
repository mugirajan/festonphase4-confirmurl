'use strict';

const admin = require('firebase-admin');

const { PENDING_COLLECTION, REGISTRATIONS_COLLECTION, SERIALS_COLLECTION } = require('./config');
const { isExpired } = require('./expiry');
const { payloadFields } = require('./payload');

/**
 * Firestore access for the confirmation flow.
 *
 * Everything here runs under the Admin SDK, which bypasses security rules —
 * which is exactly why `pending_registrations` must be closed to clients for
 * reads (rules snippet in the README). Under the magic-link shape the document
 * id is the token, so a client able to read the collection could enumerate live
 * links; no browser ever touches it, because the page is server-rendered.
 */

function db() {
    return admin.firestore();
}

function pendingRef(token) {
    return db().collection(PENDING_COLLECTION).doc(token);
}

/** Reads a pending registration, or null when the token is unknown. */
async function loadPending(token) {
    const doc = await pendingRef(token).get();
    if (!doc.exists) return null;
    return doc.data();
}

/**
 * Fields stamped onto the registration in addition to the copied payload.
 *
 * These are not in the app→web handoff spec, which asks only for the payload
 * plus `userId` and `createdAt`. They are here so a row created by this route
 * is indistinguishable in the portal from one created by the registration
 * wizard, which reads `timestamp`, `isDetailsCorrect` and `unregistered`.
 * Anything the portal does not want can be deleted from this one function.
 */
function confirmationMarkers(confirmedAt) {
    return {
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        registrationSource: 'mobile-app-confirm-link',
        unregistered: false,
        isDetailsCorrect: true,
        customerConfirmed: true,
        customerConfirmedAt: confirmedAt,
    };
}

/** Last 10 digits of a phone, for a format-agnostic comparison. */
function last10(value) {
    return typeof value === 'string' ? value.replace(/\D/g, '').slice(-10) : '';
}

/**
 * The consent + verification the customer gave on the confirm page: the two
 * acknowledgements (terms, data-for-training) and, when OTP is on, the phone
 * that was verified. Stored on the registration as a record of what was agreed.
 */
function consentFields(acknowledgements = {}, verifiedPhone) {
    const out = {};
    if (acknowledgements.acceptedTerms) out.acceptedTerms = true;
    if (acknowledgements.acceptedDataForTraining) {
        out.acceptedDataForTraining = true;
        out.dataUsageConsent = true;
    }
    if (verifiedPhone) {
        out.phoneVerified = true;
        out.phoneVerifiedNumber = verifiedPhone;
    }
    return out;
}

/**
 * Turns a pending record into a registration.
 *
 * Runs in a transaction because three documents move together and a half-done
 * confirmation is the worst outcome available: a registration with no serial
 * flipped can be registered twice, and a serial flipped with no registration
 * locks the customer out of ever registering it.
 *
 * Idempotent by design. A double-tap, a retried request, or the customer
 * reopening the link all land on the already-`completed` branch and return the
 * id written the first time rather than creating a second registration.
 *
 * Returns one of:
 *   { status: 'completed', registeredProductId, alreadyCompleted, serialFlipped }
 *   { status: 'not-found' | 'expired' | 'cancelled' | 'invalid' }
 */
async function completeRegistration(token, { userAgent, verifiedPhone, requirePhoneMatch, acknowledgements } = {}) {
    const firestore = db();
    const ref = pendingRef(token);

    return firestore.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        if (!doc.exists) return { status: 'not-found' };

        const pending = doc.data();

        // Already done — return the original id rather than registering twice.
        if (pending.status === 'completed') {
            return {
                status: 'completed',
                alreadyCompleted: true,
                registeredProductId: pending.registeredProductId || '',
            };
        }

        // 'cancelled', or anything the app invents later. Only 'pending' proceeds.
        if (pending.status && pending.status !== 'pending') {
            return { status: pending.status === 'expired' ? 'expired' : 'cancelled' };
        }

        if (isExpired(pending.expiresAt)) return { status: 'expired' };

        // Without an owner the registration would not appear in anyone's "My
        // Products", and the serial would still be flipped — leaving a product
        // that cannot be registered again and belongs to no one. Refusing is
        // recoverable; writing it is not.
        const userId = typeof pending.userId === 'string' ? pending.userId.trim() : '';
        if (!userId) return { status: 'invalid', reason: 'missing-userId' };

        // OTP: the phone verified by Firebase (from the ID token) must be the
        // customer on the pending record. Compared on the last 10 digits so a
        // +91 / spacing difference never blocks a legitimate confirm.
        if (requirePhoneMatch) {
            const want = last10(pending.customerContact) || last10(pending.customerPhone);
            const got = last10(verifiedPhone);
            if (!got || !want || got !== want) {
                return { status: 'phone-mismatch', reason: 'otp-phone-mismatch' };
            }
        }

        // Every read must precede every write in a transaction, so the serial
        // document is fetched before anything is set.
        const serialDocId = typeof pending.serialDocId === 'string' ? pending.serialDocId.trim() : '';
        let serialRef = null;
        if (serialDocId) {
            serialRef = firestore.collection(SERIALS_COLLECTION).doc(serialDocId);
            const serialDoc = await tx.get(serialRef);
            // A serial that is not in inventory is not worth failing the
            // customer's registration over — record that it was not flipped and
            // let the row be created.
            if (!serialDoc.exists) serialRef = null;
        }

        // Credit the installer who initiated this registration: an install on
        // their lifetime count, and the reward points for completing it.
        //
        // Every read must precede every write, so the installer, their company
        // and the point value are all fetched here and written further down.
        //
        // The two are DELIBERATELY INDEPENDENT. An install happened whether or
        // not points were payable — `complete_registration` could be paused in
        // `points_config`, or set to zero — and the lifetime count is a record of
        // work done, not of reward policy. Tying the count to the award would
        // silently stop counting installs the moment someone paused the payout.
        const installerId =
            typeof pending.registeredByInstallerId === 'string'
                ? pending.registeredByInstallerId.trim()
                : '';

        let awardPoints = 0;
        let installerRef = null;
        let companyRef = null;

        if (installerId) {
            const ref = firestore.collection('installers').doc(installerId);
            const installerDoc = await tx.get(ref);

            // An installer deleted between staging the link and the customer
            // confirming must not fail the registration. `tx.update` on a
            // missing document throws and would take the whole transaction —
            // and with it the customer's registration — down with it. The
            // registration is the thing that matters; the credit is not.
            if (installerDoc.exists) {
                installerRef = ref;

                // The company's lifetime count is the sum of its installers', so
                // it moves in the same transaction. Read first for the same
                // reason: a company deleted or renamed away underneath its
                // installers must not cost the customer their registration.
                const companyId = (installerDoc.data() || {}).companyId;
                if (typeof companyId === 'string' && companyId.trim()) {
                    const cRef = firestore.collection('companies').doc(companyId.trim());
                    const companyDoc = await tx.get(cRef);
                    if (companyDoc.exists) companyRef = cRef;
                }

                const cfgDoc = await tx.get(
                    firestore.collection('points_config').doc('complete_registration'),
                );
                if (cfgDoc.exists) {
                    const c = cfgDoc.data() || {};
                    const n = Number(c.points);
                    if (c.active !== false && Number.isFinite(n) && n > 0) awardPoints = n;
                }
            }
        }

        const confirmedAt = admin.firestore.Timestamp.now();
        const registrationRef = firestore.collection(REGISTRATIONS_COLLECTION).doc();

        tx.set(registrationRef, {
            ...payloadFields(pending),
            userId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            ...confirmationMarkers(confirmedAt),
            ...consentFields(acknowledgements, verifiedPhone),
        });

        if (serialRef) tx.update(serialRef, { registered: true });

        tx.update(ref, {
            status: 'completed',
            registeredProductId: registrationRef.id,
            completedAt: confirmedAt,
            completedUserAgent: (userAgent || '').slice(0, 300),
        });

        // Installer credit: the lifetime install count, the running points total
        // and a ledger row — all in the same transaction as the registration, so
        // a registration can never exist without its credit or vice versa.
        //
        // This whole block is reached only once per token: the transaction
        // returns early above when the pending document is already `completed`,
        // so a customer re-opening the confirm link cannot count the install
        // twice.
        if (installerRef) {
            const installerUpdate = {
                // The count the admin portal reads on the installers register,
                // and which the company figure below is the sum of.
                lifetimeInstalls: admin.firestore.FieldValue.increment(1),
                lastInstallAt: admin.firestore.FieldValue.serverTimestamp(),
            };

            if (awardPoints > 0) {
                installerUpdate.points = admin.firestore.FieldValue.increment(awardPoints);
                installerUpdate.pointsUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
            }

            tx.update(installerRef, installerUpdate);

            // Keep the company's rollup in step with its installers'. Both are
            // rollups of the same installs, so they are incremented together;
            // letting only one move is what makes a badge tier disagree with the
            // roster it is supposedly derived from.
            if (companyRef) {
                tx.update(companyRef, {
                    lifetimeInstalls: admin.firestore.FieldValue.increment(1),
                    lastInstallAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            }
        }

        if (installerRef && awardPoints > 0) {
            tx.set(firestore.collection('installer_points').doc(), {
                installerId,
                action: 'complete_registration',
                points: awardPoints,
                registrationId: registrationRef.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }

        return {
            status: 'completed',
            alreadyCompleted: false,
            registeredProductId: registrationRef.id,
            serialFlipped: Boolean(serialRef),
            serialDocId,
        };
    });
}

module.exports = { loadPending, completeRegistration };
