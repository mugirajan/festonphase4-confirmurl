'use strict';

/**
 * Fraud signals at confirmation (proposal slide 16).
 *
 * The entry checks live in the app: the serial must exist and be
 * unregistered, photos come from the live camera only, and the customer's
 * phone may not be the engineer's own. This module is the second line — what
 * the server can see that one phone cannot — and it runs inside the confirm
 * transaction, at the one moment every registration has to pass through.
 *
 * Signals, each a flag code on the registration (`riskFlags`):
 *
 *   installer_phone_match  the customer's number is the engineer's number
 *   duplicate_photo        an evidence photo's hash was already used on
 *                          another registration — the same picture, not a
 *                          picture of this customer's install
 *   repeat_phone           this customer phone already has two or more
 *                          registrations
 *   repeat_address         this installation address already has two or
 *                          more registrations
 *   gps_missing            no GPS pin was captured
 *   gps_pin_moved          the map pin was moved more than 500 m from the
 *                          phone's own GPS reading
 *   stale_photo            a photo was captured more than seven days before
 *                          the registration was staged, or in the future
 *
 * Why flags rather than refusals: a refusal at confirm punishes the CUSTOMER,
 * who did nothing but tap a link, and a false positive would cost them their
 * warranty. The registration goes through and the points are credited; the
 * flags queue an OTP audit automatically, and a failed audit is what claws
 * the points back (slide 14). The customer never sees any of this.
 *
 * Photo hashes are kept in `evidence_hashes/{sha256}` so the duplicate check
 * is one document read per photo, inside the transaction, with no index and
 * no scan. Written here only; readable by staff.
 */

const admin = require('firebase-admin');
const { REGISTRATIONS_COLLECTION } = require('./config');

const HASHES_COLLECTION = 'evidence_hashes';
const AUDITS_COLLECTION = 'otp_audits';

/** A photo older than this at staging time is suspicious — not taken on site today. */
const STALE_PHOTO_MS = 7 * 24 * 60 * 60 * 1000;
/** Allow for clock skew between phones. */
const FUTURE_PHOTO_MS = 60 * 60 * 1000;
/** A map pin moved further than this from the phone's GPS reading is flagged (slide 16's 500 m). */
const GPS_PIN_MOVED_M = 500;
/** Two or more OTHER registrations on the same phone or address is a cluster. */
const CLUSTER_THRESHOLD = 2;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const last10 = (v) => str(v).replace(/\D/g, '').slice(-10);
const SHA256 = /^[a-f0-9]{64}$/i;

/** `{ kind, sha256 }[]` from whatever shape the app sent; junk dropped. */
function hashesOf(pending) {
    const raw = Array.isArray(pending.evidenceHashes) ? pending.evidenceHashes : [];
    const seen = new Set();
    const out = [];
    for (const h of raw) {
        const sha256 = str(h && h.sha256).toLowerCase();
        if (!SHA256.test(sha256) || seen.has(sha256)) continue;
        seen.add(sha256);
        out.push({ kind: str(h.kind) || 'photo', sha256 });
    }
    return out;
}

function millisOf(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return value.getTime();
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? 0 : t;
}

/**
 * The READS. Must run before any write in the transaction — Firestore
 * refuses a read after a write — so this is called early and its result is
 * judged later, once the installer's row has been read too.
 */
async function readRiskSignals(tx, firestore, pending) {
    const hashes = hashesOf(pending);
    const hashDocs = [];
    for (const h of hashes) {
        const snap = await tx.get(firestore.collection(HASHES_COLLECTION).doc(h.sha256));
        hashDocs.push({ ...h, existing: snap.exists ? snap.data() || {} : null });
    }

    const phone = last10(pending.customerContact) || last10(pending.customerPhone);
    let samePhone = 0;
    if (phone) {
        for (const field of ['customerPhone', 'customerContact']) {
            for (const value of new Set([phone, '+91' + phone])) {
                const q = await tx.get(
                    firestore.collection(REGISTRATIONS_COLLECTION).where(field, '==', value).limit(CLUSTER_THRESHOLD + 1),
                );
                samePhone = Math.max(samePhone, q.docs.length);
            }
        }
    }

    const address = str(pending.installationAddress) || str(pending.selectedAddress);
    let sameAddress = 0;
    if (address) {
        const q = await tx.get(
            firestore.collection(REGISTRATIONS_COLLECTION).where('installationAddress', '==', address).limit(CLUSTER_THRESHOLD + 1),
        );
        sameAddress = q.docs.length;
    }

    return { hashDocs, samePhone, sameAddress };
}

/**
 * The JUDGEMENT. Pure: no reads, so it can run after the writes have begun
 * and can be unit-tested with plain objects.
 */
function evaluateRisk({ pending, reads, installerPhone, registrationId, now = Date.now() }) {
    const flags = [];
    const details = [];
    const add = (code, detail) => {
        flags.push(code);
        details.push({ code, detail });
    };

    const customer = last10(pending.customerContact) || last10(pending.customerPhone);
    const engineer = last10(installerPhone) || last10(pending.registeredByInstallerPhone) || last10(pending.installerContact);
    if (customer && engineer && customer === engineer) {
        add('installer_phone_match', 'The customer phone number is the engineer\'s own number.');
    }

    const reused = (reads.hashDocs || []).filter((h) => h.existing && str(h.existing.registrationId) && str(h.existing.registrationId) !== registrationId);
    if (reused.length) {
        add('duplicate_photo', `${reused.length} photo${reused.length === 1 ? '' : 's'} already used on registration ${str(reused[0].existing.registrationId)}.`);
    }

    if ((reads.samePhone || 0) >= CLUSTER_THRESHOLD) {
        add('repeat_phone', `This phone number already has ${reads.samePhone} registration${reads.samePhone === 1 ? '' : 's'}.`);
    }
    if ((reads.sameAddress || 0) >= CLUSTER_THRESHOLD) {
        add('repeat_address', `This installation address already has ${reads.sameAddress} registration${reads.sameAddress === 1 ? '' : 's'}.`);
    }

    const lat = Number(pending.gpsLat);
    const lng = Number(pending.gpsLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
        add('gps_missing', 'No GPS pin was captured with the evidence.');
    }

    // The engineer can move the pin on the map (2026-10-21). A small nudge is
    // normal — GPS is often off by tens of metres indoors — but a pin dragged
    // far from where the phone actually was is worth an audit.
    const moved = Number(pending.gpsPinMovedM);
    if (Number.isFinite(moved) && moved > GPS_PIN_MOVED_M) {
        add('gps_pin_moved', `The GPS pin was moved ${Math.round(moved)} m from the phone's own reading.`);
    }

    const staged = millisOf(pending.createdAt) || now;
    const captured = pending.evidenceCapturedAt && typeof pending.evidenceCapturedAt === 'object' ? pending.evidenceCapturedAt : {};
    for (const [kind, when] of Object.entries(captured)) {
        const t = millisOf(when);
        if (!t) continue;
        if (staged - t > STALE_PHOTO_MS) {
            add('stale_photo', `The ${kind} photo was taken ${Math.round((staged - t) / 86400000)} days before the registration was staged.`);
            break;
        }
        if (t - now > FUTURE_PHOTO_MS) {
            add('stale_photo', `The ${kind} photo carries a capture time in the future.`);
            break;
        }
    }

    return { flags, details, hashes: (reads.hashDocs || []).map(({ kind, sha256, existing }) => ({ kind, sha256, firstUse: !existing })) };
}

/** Fields written onto the registration row. Absent entirely when clean. */
function riskFields(risk, now) {
    if (!risk.flags.length) return {};
    return {
        riskFlags: risk.flags,
        riskDetails: risk.details,
        riskScore: risk.flags.length,
        riskAssessedAt: now,
    };
}

/**
 * The WRITES: remember each photo hash as used by this registration (first
 * use only — the first registration keeps its claim), and queue an OTP audit
 * when anything was flagged, so the audit console shows it without anyone
 * drawing a sample.
 */
function writeRiskRecords(tx, firestore, { risk, registrationId, installerId, installerDocId, companyId, customerPhone, now, quarterKey }) {
    for (const h of risk.hashes) {
        if (!h.firstUse) continue;
        tx.set(firestore.collection(HASHES_COLLECTION).doc(h.sha256), {
            registrationId,
            installerId: installerId || '',
            customerPhone: last10(customerPhone),
            kind: h.kind,
            createdAt: now,
        });
    }

    if (!risk.flags.length) return null;
    const auditRef = firestore.collection(AUDITS_COLLECTION).doc();
    tx.set(auditRef, {
        installId: registrationId,
        companyId: companyId || '',
        seId: installerDocId || '',
        quarter: quarterKey,
        result: 'pending',
        customer: { state: 'not-sent' },
        installer: { state: 'not-sent' },
        corrections: [],
        notes: 'Auto-queued at confirmation: ' + risk.flags.join(', '),
        flagged: true,
        flags: risk.flags,
        flagDetails: risk.details,
        createdAt: now,
    });
    return auditRef.id;
}

/** `2026-Q3` for a financial year starting in April — the portal's own key. */
function quarterKeyFor(date = new Date(), fyStartMonth = 4) {
    const start = fyStartMonth;
    const monthsIn = (date.getMonth() - (start - 1) + 12) % 12;
    const quarterIndex = Math.floor(monthsIn / 3);
    const fyStartYear = date.getMonth() >= start - 1 ? date.getFullYear() : date.getFullYear() - 1;
    return fyStartYear + '-Q' + (quarterIndex + 1);
}

module.exports = {
    HASHES_COLLECTION,
    AUDITS_COLLECTION,
    STALE_PHOTO_MS,
    CLUSTER_THRESHOLD,
    hashesOf,
    last10,
    readRiskSignals,
    evaluateRisk,
    riskFields,
    writeRiskRecords,
    quarterKeyFor,
    _admin: admin,
};
