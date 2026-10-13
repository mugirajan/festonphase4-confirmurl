'use strict';

/**
 * Finding a certificate by its number, and handing out its files.
 *
 * The certificate document is keyed on the customer's uid, but the thing a
 * customer, a friend or a Feston staffer holds is the NUMBER printed on it.
 * `confirm?action=hero&n=FSV-SSH-2026-00041` is therefore a lookup by number,
 * and the one place in this service that reads `hero_certificates` by a field
 * rather than by id.
 *
 * ── Public by number ────────────────────────────────────────────────────────
 * No login. A certificate is a thing its holder is invited to show people, and
 * "Verify at …" printed on it is a promise that anyone with the number can
 * check it. The page shows what the certificate itself shows — name, figures,
 * number, date — and nothing more: no email, no phone, no address, no uid.
 *
 * The numbers are sequential, so they are guessable, which means the set of
 * hero names is enumerable by anyone patient. That is inherent to a printed
 * verify line with a running number (the proposal's own design) and is the
 * same exposure the certificate has once posted. If Feston want it closed,
 * the fix is a random component in the number, not a login on this page.
 *
 * ── Files are proxied, not signed ───────────────────────────────────────────
 * The bytes are read from the bucket and sent by this function rather than
 * redirected to a signed URL. A signed URL needs the runtime service account to
 * hold `signBlob`, which nothing here can verify at request time; a download
 * that works on one deploy and 403s on the next is the kind of surprise a
 * certificate page should not have. The files are under 2 MB each.
 */

const { HERO_COLLECTION } = require('./config');
const { bucket } = require('./hero-issue');

/** `FSV-SSH-2026-00041`. Five-or-more digits: the sequence is never truncated. */
const NUMBER_RE = /^FSV-SSH-\d{4}-\d{5,}$/;

/** Uppercased and trimmed, or '' when it is not a certificate number at all. */
function normaliseNumber(raw) {
    const n = String(raw || '').trim().toUpperCase();
    return NUMBER_RE.test(n) ? n : '';
}

/**
 * The downloadable files, by the `?f=` value the page links with.
 *
 * `field` is the certificate-document field hero-flow.js stores the object
 * path under; `suffix` names the download so a customer's folder reads
 * `FSV-SSH-2026-00041-story.png`, not `download (3).png`.
 */
const VARIANTS = {
    png: { field: 'pngPath', contentType: 'image/png', suffix: '.png', label: 'Landscape image (PNG)' },
    pdf: { field: 'pdfPath', contentType: 'application/pdf', suffix: '.pdf', label: 'Landscape, to print (PDF)' },
    'portrait-png': { field: 'portraitPngPath', contentType: 'image/png', suffix: '-portrait.png', label: 'Portrait image (PNG)' },
    'portrait-pdf': { field: 'portraitPdfPath', contentType: 'application/pdf', suffix: '-portrait.pdf', label: 'Portrait, to print (PDF)' },
    story: { field: 'storyPngPath', contentType: 'image/png', suffix: '-story.png', label: 'Story for Instagram / WhatsApp status (1080×1920)' },
};

/** The certificate with that number, or null. `uid` is the document id. */
async function findByNumber(firestore, number) {
    const clean = normaliseNumber(number);
    if (!clean) return null;
    const snap = await firestore
        .collection(HERO_COLLECTION)
        .where('certificateNumber', '==', clean)
        .limit(1)
        .get();
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { uid: d.id, ...d.data() };
}

/**
 * Which stored file `?f=<variant>` means for this certificate, or null when
 * the variant is unknown or that file was never rendered (a certificate issued
 * before the portrait and story layouts existed has only the landscape pair
 * until it is next re-issued).
 */
function fileFor(certificate, variant) {
    const spec = VARIANTS[String(variant || '').toLowerCase()];
    if (!spec || !certificate) return null;
    const objectPath = typeof certificate[spec.field] === 'string' ? certificate[spec.field] : '';
    if (!objectPath) return null;
    return {
        path: objectPath,
        contentType: spec.contentType,
        filename: `${certificate.certificateNumber}${spec.suffix}`,
    };
}

/** The variants this certificate actually has files for, in display order. */
function availableVariants(certificate) {
    return Object.keys(VARIANTS)
        .filter((variant) => fileFor(certificate, variant))
        .map((variant) => ({ variant, label: VARIANTS[variant].label }));
}

/** The bytes of one stored file. */
async function readFile(objectPath) {
    const [bytes] = await bucket().file(objectPath).download();
    return bytes;
}

module.exports = {
    NUMBER_RE,
    VARIANTS,
    normaliseNumber,
    findByNumber,
    fileFor,
    availableVariants,
    readFile,
};
