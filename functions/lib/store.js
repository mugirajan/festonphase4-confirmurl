'use strict';

const admin = require('firebase-admin');
const { issueSuperHero } = require('./super-hero');

const { PENDING_COLLECTION, REGISTRATIONS_COLLECTION, SERIALS_COLLECTION } = require('./config');
const { isExpired } = require('./expiry');
const { payloadFields } = require('./payload');
const { resolveAward } = require('./award-rule');
const { isFirstInstall, registeredPromptly } = require('./system-awards');

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

    /**
     * Has the customer confirmed their email address?
     *
     * From Firebase AUTH, which is the only place that knows — not from the
     * registration, because a typed address is not a deliverable one and the
     * whole point of the rule is that somebody clicked the link in it.
     *
     * Non-fatal by design. An Auth lookup that fails, or an environment where
     * `getUser` is unavailable (the local harness stubs only Firestore), must
     * never take a customer's registration down. It just means the bonus is
     * not earned this time.
     */
    const emailVerifiedFor = async (uid) => {
        if (!uid) return false;
        try {
            const record = await admin.auth().getUser(uid);
            return record.emailVerified === true;
        } catch {
            return false;
        }
    };

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
        let capacityKw = null;
        if (serialDocId) {
            serialRef = firestore.collection(SERIALS_COLLECTION).doc(serialDocId);
            const serialDoc = await tx.get(serialRef);
            // A serial that is not in inventory is not worth failing the
            // customer's registration over — record that it was not flipped and
            // let the row be created.
            if (!serialDoc.exists) serialRef = null;
            else {
                // Copy the capacity onto the registration while we have the serial
                // document open. `serial_num` is the authoritative source for
                // kilowatt, and the registration has never carried it — so the
                // admin portal's "kW commissioned" KPI had to join 20,100 serial
                // documents back to a handful of installs to get a number.
                //
                // Stamping it here removes that join for every future
                // registration. It is deliberately a SNAPSHOT: if someone later
                // corrects the inventory row, this registration keeps the capacity
                // that was true when the customer confirmed it, which is what a
                // warranty record should say.
                //
                // Stored as a NUMBER. `serial_num.kilowatt` is a string ("50",
                // "3.3") and leaving it as one would push the parsing onto every
                // reader, which is how one of them ends up summing strings.
                const kw = Number((serialDoc.data() || {}).kilowatt);
                if (Number.isFinite(kw) && kw > 0) capacityKw = kw;
            }
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

        // Allocated BEFORE the awards so the system ones can key themselves on
        // the row they belong to. `.doc()` reserves an id without writing.
        const registrationRef = firestore.collection(REGISTRATIONS_COLLECTION).doc();
        const registrationRefId = registrationRef.id;

        let awardPoints = 0;
        /** 'per-kw' or 'flat' — recorded so the ledger says how it was worked out. */
        let awardBasis = 'flat';

        // The three SYSTEM awards (P6/B4) — derived, never claimed. Collected as
        // {action, points, subject, awardKey} and written after the base award.
        // See lib/system-awards.js for what each one means.
        const systemAwards = [];
        /** True when this completion is the engineer's first — read before the increment. */
        let isFirstInstallForEngineer = false;
        let installerRef = null;
        let companyRef = null;
        // The company this award belongs to, kept alongside the ref because the
        // ledger row needs the id itself. Without it the reward dashboard cannot
        // attribute a completion award to anyone: `installer_points` is keyed by
        // installer, and the portal was left joining every row back through the
        // installer list to find out whose it was.
        let awardCompanyId = '';

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

                // BEFORE the increment below. Once `lifetimeInstalls` moves, the
                // fact that this was their first is gone.
                isFirstInstallForEngineer = isFirstInstall(installerDoc.data());

                // The company's lifetime count is the sum of its installers', so
                // it moves in the same transaction. Read first for the same
                // reason: a company deleted or renamed away underneath its
                // installers must not cost the customer their registration.
                const companyId = (installerDoc.data() || {}).companyId;
                if (typeof companyId === 'string' && companyId.trim()) {
                    awardCompanyId = companyId.trim();
                    const cRef = firestore.collection('companies').doc(companyId.trim());
                    const companyDoc = await tx.get(cRef);
                    if (companyDoc.exists) companyRef = cRef;
                }

                // No flat completion award any more. `complete_registration` was
                // removed from `points_config` on 2026-08-25 — it was built during
                // the original Phase 4 work so there was something to pay, and it
                // is not part of the specified scheme.
                //
                // Base points are per-kW and nothing else: capacity × the family's
                // rate. Zero here is what makes that true, and it is passed
                // explicitly rather than dropped so `resolveAward` keeps its shape
                // and its twin in the portal stays comparable.
                //
                // ⚠ An install whose capacity cannot be read — a serial missing
                // from `serial_num` — therefore earns NOTHING for base, where it
                // used to earn the flat award. That follows from pricing by kW,
                // but it means a gap in the serial inventory now costs an
                // installer real points.
                const flatPoints = 0;

                // A per-kW rate for this product family, if Feston has priced it.
                // Read here because every read must precede every write; the
                // family comes off the pending record, which is what the app
                // recorded at review time.
                const family = String(pending.productFamily || pending.family || '').trim();
                let ratePerKw = null;
                let rateActive = false;

                // The family's own rate, falling back to the `other` catch-all —
                // the twin of `rateForFamily` in
                // feston-care/src/app/components/points-config/points-rates.types.ts.
                //
                // The fallback is what makes "all other products" a rule rather
                // than a label: a family nobody has priced individually is priced
                // here, instead of silently dropping to the flat award.
                //
                // An INACTIVE own-rate is not replaced by the catch-all. Turning
                // a family off is a decision to pay it the flat award, and
                // substituting another rate would undo that decision quietly.
                let rateDoc = family
                    ? await tx.get(firestore.collection('points_rates').doc(family))
                    : null;
                if (!rateDoc || !rateDoc.exists) {
                    rateDoc = await tx.get(firestore.collection('points_rates').doc('other'));
                }
                if (rateDoc && rateDoc.exists) {
                    const r = rateDoc.data() || {};
                    ratePerKw = Number(r.pointsPerKw);
                    rateActive = r.active !== false;
                }

                // Per-kW when priced and the capacity is known, flat otherwise.
                // `capacityKw` was resolved above from the serial document.
                const award = resolveAward({
                    flatPoints,
                    ratePerKw,
                    rateActive,
                    capacityKw,
                });
                awardPoints = award.points;
                awardBasis = award.basis;

                // ── The system awards ────────────────────────────────────────
                //
                // Read every config document here, with the other reads, because
                // a transaction must do all of its reading before any writing.
                //
                // Each one is skipped silently when its rule is paused or set to
                // zero in Points Configuration. A paused rule is a deliberate
                // decision by Feston, and paying it anyway would ignore them.
                // The Auth lookup, awaited here so it happens once per
                // completion rather than once per rule. Non-fatal — see the
                // helper.
                const customerEmailVerified = await emailVerifiedFor(userId);

                const systemRules = [
                    {
                        key: 'registration_within_48h',
                        subject: 'installer',
                        // From the install date to when the INSTALLER submitted —
                        // not to when the customer confirmed. The installer does
                        // not control how long a customer takes to open a link.
                        earned: registeredPromptly(pending.installationDate, pending.createdAt),
                        awardKey: 'registration_within_48h:reg:' + registrationRefId,
                    },
                    {
                        key: 'new_se_first_install',
                        // Owed to the COMPANY — the scheme rewards a firm for
                        // onboarding somebody who then did the work — but keyed
                        // on the ENGINEER, so it is earned once per new engineer
                        // rather than once ever.
                        subject: 'company',
                        earned: isFirstInstallForEngineer && !!awardCompanyId,
                        awardKey: 'new_se_first_install:se:' + installerId,
                    },
                    {
                        key: 'customer_email_verified',
                        subject: 'installer',
                        earned: customerEmailVerified,
                        awardKey: 'customer_email_verified:cust:' + userId,
                    },
                ];

                for (const rule of systemRules) {
                    if (!rule.earned) continue;
                    const cfg = await tx.get(firestore.collection('points_config').doc(rule.key));
                    if (!cfg.exists) continue;
                    const data = cfg.data() || {};
                    const value = Number(data.points);
                    if (data.active === false || !Number.isFinite(value) || value <= 0) continue;
                    systemAwards.push({
                        action: rule.key,
                        points: Math.round(value),
                        subject: rule.subject,
                        awardKey: rule.awardKey,
                    });
                }
            }
        }

        const confirmedAt = admin.firestore.Timestamp.now();

        tx.set(registrationRef, {
            ...payloadFields(pending),
            userId,
            // Null when the serial was not in inventory — absent rather than 0, so
            // a reader can tell "not known" from "a zero-kilowatt install".
            capacityKw,
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

        // ── The system awards ────────────────────────────────────────────
        //
        // Written after the base award and separately, because they are separate
        // awards: each is its own ledger row with its own action, so an installer
        // reading their history sees WHY they were paid rather than one merged
        // number they cannot account for.
        //
        // A company-subject award goes to `company_points`, not to the engineer.
        // `new_se_first_install` rewards the FIRM for onboarding somebody who
        // then did the work; paying the engineer would credit them for their own
        // hiring.
        for (const award of systemAwards) {
            if (award.subject === 'company') {
                if (!awardCompanyId) continue;
                tx.set(firestore.collection('company_points').doc(), {
                    companyId: awardCompanyId,
                    action: award.action,
                    points: award.points,
                    type: 'credit',
                    awardKey: award.awardKey,
                    registrationId: registrationRef.id,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    createdByName: 'system',
                });
                continue;
            }

            if (!installerRef) continue;
            tx.update(installerRef, {
                points: admin.firestore.FieldValue.increment(award.points),
                pointsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            tx.set(firestore.collection('installer_points').doc(), {
                installerId,
                companyId: awardCompanyId,
                action: award.action,
                points: award.points,
                type: 'credit',
                awardKey: award.awardKey,
                registrationId: registrationRef.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }

        if (installerRef && awardPoints > 0) {
            tx.set(firestore.collection('installer_points').doc(), {
                installerId,
                    companyId: awardCompanyId,
                // The ledger key stays `complete_registration`: it is what every
                // row ever written carries, and the portal's history labels it.
                // Renaming it would orphan the existing rows rather than tidy
                // them. What changed is how the figure is reached, not what the
                // award is for.
                action: 'complete_registration',
                points: awardPoints,
                // How the figure was reached, so a ledger row can be explained
                // later without re-deriving it from config that may have moved.
                awardBasis,
                capacityKw,
                registrationId: registrationRef.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }

        // Solar Super Hero — issued to the CUSTOMER, every time, whatever the
        // system size. Inside the transaction on purpose: a certificate exists
        // if and only if a registration does, so it can never be issued for an
        // abandoned confirm, and a retry cannot mint a second one.
        //
        // It runs LAST so a failure here cannot cost the registration or the
        // installer's points — but note that being in the transaction means a
        // throw would roll all of it back. `issueSuperHero` is written not to
        // throw: a missing email is skipped, not raised.
        const superHero = await issueSuperHero(tx, firestore, {
            id: registrationRef.id,
            userId: pending.userId || '',
            customerName: pending.customerName || '',
            customerEmail: pending.customerEmail || '',
            serialnumber: pending.serialnumber || '',
            installationDate: pending.installationDate || '',
            capacityKw,
        });

        return {
            status: 'completed',
            alreadyCompleted: false,
            registeredProductId: registrationRef.id,
            serialFlipped: Boolean(serialRef),
            serialDocId,
            // So the confirm page can congratulate the customer by number
            // rather than making them wait for the email.
            superHeroCertificate: superHero.sequenceNo,
            // For the caller to send AFTER this transaction commits. Null when
            // the customer gave no email address.
            superHeroMailId: superHero.mailDocId || null,
        };
    });
}

module.exports = { loadPending, completeRegistration };
