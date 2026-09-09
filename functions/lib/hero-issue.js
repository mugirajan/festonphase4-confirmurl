'use strict';

/**
 * Issuing a Solar Super Hero certificate.
 *
 * One certificate per CUSTOMER, not one per product. Registering a second
 * system does not mint a second certificate — it re-renders the existing one
 * with the combined capacity, under the number that customer has always had.
 * That is why almost everything here is keyed on `uid`, and why the number is
 * read back from the stored document rather than allocated again.
 *
 * The work is split deliberately:
 *
 *   plan()    transactional: decides WHETHER to issue and with what figures,
 *             and allocates the number. Fast, and safe to run twice.
 *   render()  slow and external: Chrome and Cloud Storage. Outside the
 *             transaction, because a Firestore transaction that holds a browser
 *             open for two seconds is a transaction that will be retried — and
 *             every retry would render again.
 *
 * That split is also what makes the whole thing idempotent. Two registrations
 * confirmed at the same moment serialise on the certificate document; the loser
 * reads the figures the winner just wrote and skips the render entirely.
 */

const admin = require('firebase-admin');
const {
    HERO_COLLECTION,
    HERO_STORAGE_PREFIX,
    HERO_BUCKET,
    HERO_SIGNATORY_NAME,
    HERO_SIGNATORY_DESIGNATION,
    heroVerifyUrl,
    REGISTRATIONS_COLLECTION,
} = require('./config');
const { totalCapacityKw, impactFor } = require('./hero-impact');
const { formatNumber, issueYear, allocateSequence } = require('./hero-number');
const { buildQrSvg } = require('./hero-qr');
const { renderHeroCertificateHtml } = require('./hero-certificate');
const { renderCertificate } = require('./hero-render');

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * The customer's name and email for the certificate.
 *
 * Taken from the REGISTRATIONS, newest first, rather than from a profile row.
 * The registration is what the customer typed and then confirmed in their own
 * browser behind an OTP, so it is the best-attested spelling of their name that
 * exists anywhere — and this certificate prints that name at 46px. A profile
 * row, by contrast, may never have been filled in at all.
 */
function identityFrom(registrations) {
    for (const reg of registrations) {
        const name = str(reg.customerName);
        if (name) return { name, email: str(reg.customerEmail) };
    }
    return { name: '', email: '' };
}

/** Epoch millis from a Firestore Timestamp, a Date, a number or an ISO string. */
function millisOf(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return value.getTime();
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? 0 : t;
}

/** Every registration this customer owns, newest first. */
async function loadRegistrations(firestore, uid) {
    const snap = await firestore
        .collection(REGISTRATIONS_COLLECTION)
        .where('userId', '==', uid)
        .get();
    return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => millisOf(b.createdAt) - millisOf(a.createdAt));
}

/**
 * Decides what this customer's certificate should say, and reserves its number.
 *
 * Returns `{ action, certificate }` where action is one of:
 *   'create'  first certificate for this customer — render it and email it.
 *   'update'  the figures moved (another system registered) — re-render, and
 *             email again: their impact went up, and that is the news.
 *   'skip'    nothing a customer would notice has changed.
 */
async function plan(firestore, uid, registrations) {
    const identity = identityFrom(registrations);
    if (!identity.name) return { action: 'skip', reason: 'no-customer-name' };

    const capacityKw = totalCapacityKw(registrations);
    const impact = impactFor(capacityKw);
    if (!impact.co2Tonnes) {
        // No capacity recorded on any of their registrations. A certificate
        // claiming an impact we cannot substantiate is worse than none.
        return { action: 'skip', reason: 'no-capacity' };
    }

    const ref = firestore.collection(HERO_COLLECTION).doc(uid);

    return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const existing = snap.exists ? snap.data() : null;

        // The number, its year, and therefore the identity of this certificate
        // are set once and read back forever after.
        let certificateNumber = existing ? str(existing.certificateNumber) : '';
        let sequence = existing ? Number(existing.sequence) : null;
        let year = existing ? Number(existing.year) : null;
        let allocation = null;

        if (!certificateNumber) {
            year = issueYear();
            allocation = await allocateSequence(tx, firestore);
            sequence = allocation.sequence;
            certificateNumber = formatNumber(year, sequence);
        }

        const unchanged =
            existing &&
            existing.status === 'ready' &&
            str(existing.customerName) === identity.name &&
            Number(existing.capacityKw) === impact.capacityKw &&
            Number(existing.co2Tonnes) === impact.co2Tonnes;

        if (unchanged) {
            return { action: 'skip', reason: 'unchanged', certificate: { uid, ...existing } };
        }

        const version = existing ? Number(existing.version || 0) + 1 : 1;
        const now = admin.firestore.FieldValue.serverTimestamp();

        const certificate = {
            uid,
            certificateNumber,
            sequence,
            year,
            customerName: identity.name,
            customerEmail: identity.email,
            capacityKw: impact.capacityKw,
            co2Tonnes: impact.co2Tonnes,
            trees: impact.trees,
            registrationIds: registrations.map((r) => r.id),
            registrationCount: registrations.length,
            version,
            // Marked as rendering BEFORE Chrome is touched, so no reader ever
            // sees a certificate whose figures have moved past its files.
            status: 'rendering',
            updatedAt: now,
        };
        if (!existing) certificate.issuedAt = now;
        if (allocation) allocation.commit();

        tx.set(ref, certificate, { merge: true });

        return {
            action: existing ? 'update' : 'create',
            // `issuedAt` is a sentinel on a first issue and unreadable until the
            // transaction commits; the caller re-reads it before rendering.
            certificate: {
                ...certificate,
                issuedAt: existing ? existing.issuedAt : null,
            },
        };
    });
}

function bucket() {
    return HERO_BUCKET ? admin.storage().bucket(HERO_BUCKET) : admin.storage().bucket();
}

/** `hero-certificates/<uid>/<number>.png` — stable for the life of the certificate. */
function storagePath(uid, certificateNumber, ext) {
    return `${HERO_STORAGE_PREFIX}/${uid}/${certificateNumber}.${ext}`;
}

/**
 * Renders the certificate and uploads both files.
 *
 * The date PRINTED on it is the ORIGINAL issue date, even on a reissue: the
 * customer became a Solar Super Hero the day they first went solar, not the day
 * they added a second array. A first issue has no committed timestamp to read
 * yet, so it falls back to now — which is the same instant, to the second.
 */
async function render(certificate) {
    const { uid, certificateNumber, customerName, co2Tonnes, trees } = certificate;
    const verifyUrl = heroVerifyUrl(certificateNumber);
    const issuedMillis = millisOf(certificate.issuedAt);

    const html = renderHeroCertificateHtml({
        customerName,
        issuedAt: issuedMillis ? new Date(issuedMillis) : new Date(),
        co2Tonnes,
        trees,
        certificateNumber,
        verifyUrl,
        qrSvg: verifyUrl ? await buildQrSvg(verifyUrl) : '',
        signatoryName: HERO_SIGNATORY_NAME,
        signatoryDesignation: HERO_SIGNATORY_DESIGNATION,
    });

    const { png, pdf } = await renderCertificate(html);
    const b = bucket();
    const pngPath = storagePath(uid, certificateNumber, 'png');
    const pdfPath = storagePath(uid, certificateNumber, 'pdf');

    // The object path deliberately does not change between versions, so a
    // customer's certificate keeps one address for its whole life. `version` in
    // the custom metadata is what lets a client tell a re-rendered file from a
    // cached one, and `must-revalidate` is what makes it ask.
    const meta = { version: String(certificate.version), certificateNumber };
    const options = (contentType) => ({
        resumable: false,
        contentType,
        metadata: {
            cacheControl: 'private, max-age=0, must-revalidate',
            metadata: meta,
        },
    });

    await Promise.all([
        b.file(pngPath).save(png, options('image/png')),
        b.file(pdfPath).save(pdf, options('application/pdf')),
    ]);

    return { pngPath, pdfPath, pngBytes: png.length, pdfBytes: pdf.length };
}

/**
 * A time-limited HTTPS URL for one of the files.
 *
 * For the email attachment: the mail extension fetches the file at send time,
 * so the URL only has to outlive the send queue. Seven days is the v4 maximum
 * and far more headroom than that needs.
 */
async function signedUrl(path, days = 7) {
    const [url] = await bucket()
        .file(path)
        .getSignedUrl({
            action: 'read',
            expires: Date.now() + days * 24 * 60 * 60 * 1000,
            version: 'v4',
        });
    return url;
}

module.exports = {
    identityFrom,
    millisOf,
    loadRegistrations,
    plan,
    render,
    signedUrl,
    storagePath,
    bucket,
};
