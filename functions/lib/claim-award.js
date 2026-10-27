'use strict';

/**
 * Points for an install photo, paid on upload — `POST ?action=award-claim`.
 *
 * Requested 2026-10-21: the separate "Submit a points claim" screen goes, and
 * the evidence rules (LinkedIn post, Google review, EB bill, …) become kinds of
 * photo on the install's own Attach files screen. A photo filed under a
 * rewarded kind pays the engineer AT ONCE — no Feston review in between.
 *
 * Hosted on `confirm` for the same reason as lookup-customer: a new function
 * cannot be made public by the account that deploys here.
 *
 * What replaces the human review, all checked here and never trusted from the
 * app:
 *   - the caller's ID token, and an ACTIVE installer row behind it;
 *   - the caller is on the install — its submitter or a member of its team;
 *   - the photo is really in that install's `product_files/{registrationId}/`
 *     folder, and its bytes (hashed here, from Storage) have not been used on
 *     any other install or award before — `evidence_hashes`, the same register
 *     the confirm-time fraud check fills;
 *   - the rule is switched on in Points Configuration and worth more than 0;
 *   - the award has not been paid already. The claim document's id IS derived
 *     from the award key, so two uploads racing for the same award collide on
 *     one document inside the transaction and only one of them pays.
 *
 * Every award still lands as an approved `points_claims` row, so Feston sees it
 * on the portal's Points Claims page and in the ledger exactly as before.
 */

const crypto = require('node:crypto');
const { findInstallerByUid } = require('./installer-lookup');
const { REGISTRATIONS_COLLECTION } = require('./config');

const HASHES_COLLECTION = 'evidence_hashes';
const CLAIMS_COLLECTION = 'points_claims';

/**
 * The rules a photo can earn — the claim rules of the catalogue (the portal's
 * `points-catalogue.types.ts` and the app's `pointsCatalogue.ts`). Values come
 * from `points_config`; only the key, who is paid and how often matter here.
 */
const PHOTO_RULES = {
    wifi_logger: { label: 'Wi-Fi logger recorded', subject: 'installer', scope: 'per-install-once' },
    customer_app_activated: { label: 'Customer app activated', subject: 'installer', scope: 'per-customer-lifetime' },
    video_testimonial: { label: 'Video testimonial', subject: 'installer', scope: 'per-customer-lifetime' },
    eb_bill_before_after: { label: 'EB bill, before and after', subject: 'installer', scope: 'per-customer-lifetime' },
    google_review: { label: 'Google review for Feston', subject: 'installer', scope: 'per-customer-lifetime' },
    linkedin_post: { label: 'LinkedIn post — Solar Super Hero', subject: 'installer', scope: 'per-customer-lifetime' },
    facebook_post: { label: 'Facebook post — Solar Super Hero', subject: 'installer', scope: 'per-customer-lifetime' },
    instagram_post: { label: 'Instagram post — Solar Super Hero', subject: 'installer', scope: 'per-customer-lifetime' },
    whatsapp_post: { label: 'WhatsApp post — Solar Super Hero', subject: 'installer', scope: 'per-customer-lifetime' },
    printed_certificate: { label: 'Printed certificate issued to customer', subject: 'company', scope: 'per-customer-lifetime' },
};

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Same shape as the app's and portal's `awardKey`. '' when the id the scope needs is missing. */
function awardKeyFor(ruleKey, rule, { registrationId, customerId }) {
    if (rule.scope === 'per-install-once') return registrationId ? `${ruleKey}:reg:${registrationId}` : '';
    if (rule.scope === 'per-customer-lifetime') return customerId ? `${ruleKey}:cust:${customerId}` : '';
    return '';
}

/** One document per award: the id is the key's hash, so a second payment collides. */
/**
 * What a set of ledger rows for one award still pays: credits minus debits
 * (2026-10-26). A photo award Feston took back leaves its credit row and a
 * debit row with the same awardKey; counting the credit alone read as "still
 * earned", so the install summary showed it as earned and a correct photo
 * could not earn it again.
 */
function netCredits(snap) {
    let net = 0;
    for (const d of snap.docs) {
        const r = d.data() || {};
        const pts = Number(r.points) || 0;
        net += str(r.type) === 'debit' ? -pts : pts;
    }
    return net;
}

function claimIdFor(awardKey) {
    return 'auto_' + crypto.createHash('sha256').update(awardKey).digest('hex').slice(0, 40);
}

const reply = (status, body) => ({ status, body });

/**
 * @param {object} p
 * @param {FirebaseFirestore.Firestore} p.firestore
 * @param {(token: string) => Promise<{uid: string}>} p.verifyIdToken
 * @param {string} p.authorization  the request's Authorization header
 * @param {object} p.body           { registrationId, kind, storagePath, productFileId? }
 * @param {(path: string) => Promise<Buffer>} p.readObject  Storage bytes for a path
 * @param {() => any} p.now         server timestamp sentinel (injected for tests)
 * @returns {Promise<{status: number, body: object}>}
 */
async function awardPhotoClaim({ firestore, verifyIdToken, authorization, body, readObject, now, logger }) {
    const bearer = /^Bearer\s+(.+)$/i.exec(str(authorization));
    if (!bearer) return reply(401, { status: 'unauthenticated' });
    let uid = '';
    try {
        uid = str((await verifyIdToken(bearer[1])).uid);
    } catch (error) {
        if (logger) logger.warn('award-claim: token verification failed', error);
    }
    if (!uid) return reply(401, { status: 'unauthenticated' });

    const b = body && typeof body === 'object' ? body : {};
    const registrationId = str(b.registrationId);
    const ruleKey = str(b.kind);
    const storagePath = str(b.storagePath);
    const productFileId = str(b.productFileId);

    const rule = PHOTO_RULES[ruleKey];
    if (!rule) return reply(400, { status: 'not-rewarded', message: 'This kind of photo does not earn points.' });
    if (!registrationId || !storagePath) return reply(400, { status: 'bad-request' });
    // The photo must be in this install's own folder — not someone else's file.
    if (!storagePath.startsWith(`product_files/${registrationId}/`)) {
        return reply(400, { status: 'bad-request', message: 'That photo is not attached to this install.' });
    }

    const installer = await findInstallerByUid(firestore, uid);
    if (!installer || (installer.data() || {}).active === false) return reply(403, { status: 'not-installer' });
    const se = installer.data() || {};

    const regSnap = await firestore.collection(REGISTRATIONS_COLLECTION).doc(registrationId).get();
    if (!regSnap.exists) return reply(404, { status: 'no-registration' });
    const reg = regSnap.data() || {};
    const team = Array.isArray(reg.installTeamUids) ? reg.installTeamUids.map(str) : [];
    if (str(reg.registeredByInstallerId) !== uid && !team.includes(uid)) {
        return reply(403, { status: 'not-on-install', message: 'Only an engineer who worked on this install earns points for it.' });
    }

    const customerId = str(reg.userId);
    const awardKey = awardKeyFor(ruleKey, rule, { registrationId, customerId });
    if (!awardKey) return reply(422, { status: 'no-customer', message: 'This install has no customer to key the award on.' });

    // Hash the bytes actually stored — a hash sent by the app could be anything.
    let sha256 = '';
    try {
        sha256 = crypto.createHash('sha256').update(await readObject(storagePath)).digest('hex');
    } catch (error) {
        if (logger) logger.warn('award-claim: photo could not be read', { storagePath, error: String(error) });
        return reply(404, { status: 'no-photo', message: 'The photo could not be found. Upload it again.' });
    }

    const companyId = str(se.companyId) || str(reg.companyId);
    const claimRef = firestore.collection(CLAIMS_COLLECTION).doc(claimIdFor(awardKey));
    const hashRef = firestore.collection(HASHES_COLLECTION).doc(sha256);
    const cfgRef = firestore.collection('points_config').doc(ruleKey);
    const fileRef = productFileId ? firestore.collection('product_files').doc(productFileId) : null;

    return firestore.runTransaction(async (tx) => {
        // All reads first — Firestore refuses a read after a write.
        const [claimSnap, hashSnap, cfgSnap, seSnap] = await Promise.all([
            tx.get(claimRef),
            tx.get(hashRef),
            tx.get(cfgRef),
            tx.get(installer.ref),
        ]);
        // A claim filed the old way (reviewed) for the same award also holds it.
        const manual = await tx.get(
            firestore.collection(CLAIMS_COLLECTION).where('awardKey', '==', awardKey).limit(10),
        );
        // So does a ledger row paid by any other route — e.g. the Wi-Fi logger
        // photo from the wizard, paid at confirm by lib/store.js.
        const ledgerName = rule.subject === 'company' ? 'company_points' : 'installer_points';
        const paidElsewhere = await tx.get(
            firestore.collection(ledgerName).where('awardKey', '==', awardKey).limit(10),
        );

        const held = manual.docs.map((d) => str((d.data() || {}).status).toLowerCase() || 'pending').filter((s) => s !== 'rejected');
        const subject = rule.scope === 'per-install-once' ? 'install' : 'customer';
        // This route's own claim holds the award unless Feston rejected it (a
        // take-back); then the award is open again for a correct photo.
        const ownClaimHolds = claimSnap.exists && str((claimSnap.data() || {}).status).toLowerCase() !== 'rejected';
        if (ownClaimHolds || held.includes('approved') || netCredits(paidElsewhere) > 0) {
            return reply(200, { status: 'already-paid', label: rule.label, message: `"${rule.label}" has already been credited for this ${subject}.` });
        }
        if (held.length) {
            // A claim filed on the old reviewed screen, still waiting on Feston.
            return reply(200, { status: 'already-submitted', label: rule.label, message: `"${rule.label}" for this ${subject} is already waiting for Feston's decision.` });
        }
        if (hashSnap.exists) {
            return reply(409, { status: 'duplicate-photo', message: 'This photo has already been used before, so it cannot earn points again.' });
        }
        const cfg = cfgSnap.exists ? cfgSnap.data() || {} : null;
        const points = Math.round(Number(cfg && cfg.points));
        if (!cfg || cfg.active === false || !Number.isFinite(points) || points <= 0) {
            return reply(200, { status: 'paused', label: rule.label, message: `"${rule.label}" does not earn points right now. The photo is saved.` });
        }
        if (rule.subject === 'company' && !companyId) {
            return reply(422, { status: 'no-company', message: 'Your company is not set, so this cannot be credited.' });
        }

        const base = {
            action: ruleKey,
            points,
            type: 'credit',
            awardKey,
            claimId: claimRef.id,
            registrationId,
            createdAt: now(),
        };
        if (rule.subject === 'company') {
            tx.set(firestore.collection('company_points').doc(), {
                ...base,
                companyId,
                companyName: str(se.companyName),
                label: rule.label,
                createdByName: 'Automatic — paid on upload',
            });
        } else {
            tx.update(seSnap.ref, { points: (Number(seSnap.get('points')) || 0) + points, pointsUpdatedAt: now() });
            tx.set(firestore.collection('installer_points').doc(), {
                ...base,
                // Keyed on the installers DOC id like every ledger row — the
                // app's wallet history reads by that id.
                installerId: seSnap.id,
                installerUid: uid,
                installerName: str(se.name),
                companyId,
            });
        }

        tx.set(claimRef, {
            action: ruleKey,
            label: rule.label,
            status: 'approved',
            autoApproved: true,
            installerId: uid,
            installerName: str(se.name),
            companyId,
            companyName: str(se.companyName),
            registrationId,
            customerId,
            customerName: str(reg.customerName),
            subjectLabel: str(reg.serialnumber) || str(reg.Serialnumber),
            proofPath: storagePath,
            proofUrl: str(b.proofUrl),
            productFileId,
            points,
            awardedPoints: points,
            awardKey,
            submittedAt: now(),
            submittedBy: uid,
            decidedAt: now(),
            decidedBy: 'system',
            decidedByName: 'Automatic — paid on upload',
            decisionMessage: 'Paid automatically when the photo was uploaded.',
        });
        tx.set(hashRef, { registrationId, installerId: uid, kind: ruleKey, claimId: claimRef.id, createdAt: now() });
        if (fileRef) tx.set(fileRef, { awardedPoints: points, claimId: claimRef.id }, { merge: true });

        return reply(200, {
            status: 'paid',
            points,
            paidTo: rule.subject,
            label: rule.label,
            message: rule.subject === 'company'
                ? `${points} points credited to your company for "${rule.label}".`
                : `${points} points credited for "${rule.label}".`,
        });
    });
}

/**
 * `POST ?action=claim-rules` — what each photo kind is worth right now, for the
 * app's Attach files chips. Engineers may not read `points_config` themselves
 * (rules), so the values come through here, for an active installer only.
 */
async function listPhotoRules({ firestore, verifyIdToken, authorization, logger }) {
    const bearer = /^Bearer\s+(.+)$/i.exec(str(authorization));
    if (!bearer) return reply(401, { status: 'unauthenticated' });
    let uid = '';
    try {
        uid = str((await verifyIdToken(bearer[1])).uid);
    } catch (error) {
        if (logger) logger.warn('claim-rules: token verification failed', error);
    }
    if (!uid) return reply(401, { status: 'unauthenticated' });
    const installer = await findInstallerByUid(firestore, uid);
    if (!installer || (installer.data() || {}).active === false) return reply(403, { status: 'not-installer' });

    const rules = [];
    for (const [kind, rule] of Object.entries(PHOTO_RULES)) {
        const snap = await firestore.collection('points_config').doc(kind).get();
        const cfg = snap.exists ? snap.data() || {} : {};
        const points = Math.round(Number(cfg.points));
        rules.push({
            kind,
            label: rule.label,
            subject: rule.subject,
            points: Number.isFinite(points) && points > 0 ? points : 0,
            active: snap.exists && cfg.active !== false && Number.isFinite(points) && points > 0,
        });
    }
    return reply(200, { status: 'ok', rules });
}

/** Names for the ledger actions an install earns, for the points summary. */
const ACTION_LABELS = {
    complete_registration: 'Install points',
    registration_within_48h: 'Registered within 48 hours',
    customer_email_verified: 'Customer email verified',
    new_se_first_install: "New engineer's first install",
};

/**
 * The points picture for one install, for the app's Install photos screen
 * (2026-10-22): what has been earned from it, and which photo rewards are
 * still open for this customer and worth how much.
 *
 * body: { registrationId }. The caller must have worked on the install, as
 * for awardPhotoClaim. A photo rule counts as earned when the ledger already
 * holds its award key (paid by any route — wizard, confirm, upload) or a claim
 * for it is still waiting; the same test awardPhotoClaim applies.
 */
async function installPoints({ firestore, verifyIdToken, authorization, body, logger }) {
    const bearer = /^Bearer\s+(.+)$/i.exec(str(authorization));
    if (!bearer) return reply(401, { status: 'unauthenticated' });
    let uid = '';
    try {
        uid = str((await verifyIdToken(bearer[1])).uid);
    } catch (error) {
        if (logger) logger.warn('install-points: token verification failed', error);
    }
    if (!uid) return reply(401, { status: 'unauthenticated' });

    const registrationId = str(body && body.registrationId);
    if (!registrationId) return reply(400, { status: 'bad-request' });
    const installer = await findInstallerByUid(firestore, uid);
    if (!installer || (installer.data() || {}).active === false) return reply(403, { status: 'not-installer' });

    const regSnap = await firestore.collection(REGISTRATIONS_COLLECTION).doc(registrationId).get();
    if (!regSnap.exists) return reply(404, { status: 'no-registration' });
    const reg = regSnap.data() || {};
    const team = Array.isArray(reg.installTeamUids) ? reg.installTeamUids.map(str) : [];
    if (str(reg.registeredByInstallerId) !== uid && !team.includes(uid)) {
        return reply(403, { status: 'not-on-install' });
    }
    const customerId = str(reg.userId);

    // Everything paid against this install, engineers' and company's.
    const [own, company] = await Promise.all([
        firestore.collection('installer_points').where('registrationId', '==', registrationId).limit(200).get(),
        firestore.collection('company_points').where('registrationId', '==', registrationId).limit(200).get(),
    ]);
    const credit = (d) => {
        const r = d.data() || {};
        return str(r.type) !== 'debit' ? Number(r.points) || 0 : -(Number(r.points) || 0);
    };
    const earnedByAction = new Map();
    let earnedTotal = 0;
    let myTotal = 0;
    for (const d of [...own.docs, ...company.docs]) {
        const r = d.data() || {};
        const action = str(r.action);
        const pts = credit(d);
        earnedTotal += pts;
        if (str(r.installerId) === uid) myTotal += pts;
        const label = ACTION_LABELS[action] || (PHOTO_RULES[action] && PHOTO_RULES[action].label) || action || 'Points';
        earnedByAction.set(label, (earnedByAction.get(label) || 0) + pts);
    }
    // An action whose credits were all taken back nets to nothing and is not
    // "earned"; it is left out rather than shown as a dash.
    const earned = [...earnedByAction.entries()].map(([label, points]) => ({ label, points })).filter((e) => e.points > 0);

    // Each photo reward: earned already (here or for this customer elsewhere),
    // or open — with what it is worth now.
    const rules = [];
    let availableTotal = 0;
    for (const [kind, rule] of Object.entries(PHOTO_RULES)) {
        const cfgSnap = await firestore.collection('points_config').doc(kind).get();
        const cfg = cfgSnap.exists ? cfgSnap.data() || {} : {};
        const points = Math.round(Number(cfg.points));
        const active = cfgSnap.exists && cfg.active !== false && Number.isFinite(points) && points > 0;
        if (!active) continue;
        const awardKey = awardKeyFor(kind, rule, { registrationId, customerId });
        if (!awardKey) continue;
        const ledgerName = rule.subject === 'company' ? 'company_points' : 'installer_points';
        const [paid, claims] = await Promise.all([
            firestore.collection(ledgerName).where('awardKey', '==', awardKey).limit(10).get(),
            firestore.collection(CLAIMS_COLLECTION).where('awardKey', '==', awardKey).limit(10).get(),
        ]);
        const held = claims.docs.some((c) => (str((c.data() || {}).status).toLowerCase() || 'pending') !== 'rejected');
        const done = netCredits(paid) > 0 || held;
        rules.push({ kind, label: rule.label, points, subject: rule.subject, status: done ? 'earned' : 'available' });
        if (!done) availableTotal += points;
    }

    // A shared install's points not yet divided by the company admin
    // (lib/points-split.js) — earned, but not paid to anyone yet.
    const splitSnap = await firestore.collection('points_splits').doc(registrationId).get();
    const split = splitSnap.exists ? splitSnap.data() || {} : {};
    const heldTotal = str(split.status) === 'pending' ? Number(split.remaining) || 0 : 0;

    return reply(200, { status: 'ok', earned, earnedTotal, myTotal, heldTotal, rules, availableTotal });
}

module.exports = { awardPhotoClaim, listPhotoRules, installPoints, PHOTO_RULES, awardKeyFor, claimIdFor };
