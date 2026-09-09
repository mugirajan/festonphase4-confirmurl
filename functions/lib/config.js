'use strict';

const { TTL_MINUTES, TTL_HOURS } = require('./expiry');

/**
 * Deploy-time settings. All optional — the defaults are correct for a plain
 * deploy of this codebase to `feston-prod`.
 *
 * Set these in `functions/.env` (see `.env.example`).
 */

/**
 * Collection the mobile app writes one document to per confirmation link.
 *
 * The document id IS the link token (the "magic link" shape), so this
 * collection must never be readable by a browser: holding the id is holding
 * the credential, and the document carries the customer's name, phone, email
 * and installation address. Every read here goes through the Admin SDK.
 */
const PENDING_COLLECTION = process.env.PENDING_COLLECTION || 'pending_registrations';

/** Where the confirmed registration is created. */
const REGISTRATIONS_COLLECTION = process.env.REGISTRATIONS_COLLECTION || 'registered_products';

/** Serial-number inventory; `registered` is flipped true on confirmation. */
const SERIALS_COLLECTION = process.env.SERIALS_COLLECTION || 'serial_num';

/**
 * Public base of the customer-facing link. `?t=<token>` is appended.
 *
 * This is the `{CONFIRM_URL}` the mobile app is configured with, and it is a
 * Hosting path rather than the raw function URL because the customer sees it —
 * a `cloudfunctions.net` link arriving by SMS reads as a phishing attempt. The
 * path is mapped to this function by a rewrite in the feston-care Hosting
 * config (see README).
 *
 * The default is the project's own Hosting domain, which works as soon as that
 * rewrite is deployed. Note it is NOT `www.festonsev.com` — that name is a
 * WordPress site on other infrastructure and cannot rewrite to a function. To
 * put the link on a Feston domain, add a subdomain such as
 * `register.festonsev.com` to Firebase Hosting and set this variable to it.
 * Agree the value with the app team before they ship: changing it later means
 * re-releasing the app.
 */
const PUBLIC_BASE_URL = (
    process.env.CONFIRM_PUBLIC_BASE_URL || 'https://feston-prod.web.app/app/register/confirm'
).replace(/\/+$/, '');

/**
 * Optional absolute URL of the Feston logo.
 *
 * Left unset the page renders a styled "FESTON" wordmark, which keeps the page
 * self-contained — one request, nothing to fail on a weak mobile connection.
 * Set it only to a URL that is publicly readable without auth.
 */
const LOGO_URL = process.env.CONFIRM_LOGO_URL || '';

/**
 * Firebase web config for the feston-prod project, embedded in the confirm page
 * so it can run Phone Authentication (OTP) client-side. These are public
 * identifiers (the same ones ship in the mobile app), not secrets.
 */
const FIREBASE_WEB_CONFIG = {
    apiKey: process.env.CONFIRM_FIREBASE_API_KEY || 'AIzaSyAqCKAYTJFw8pm0hhuGg8u0bodOziIixeo',
    authDomain: process.env.CONFIRM_FIREBASE_AUTH_DOMAIN || 'feston-prod.firebaseapp.com',
    projectId: process.env.CONFIRM_FIREBASE_PROJECT_ID || 'feston-prod',
    appId:
        process.env.CONFIRM_FIREBASE_APP_ID ||
        '1:754815765289:web:ace860ec7f9601bcd7c538',
};

/**
 * When true, the customer must pass a phone OTP (Firebase Phone Auth) before the
 * registration is written; the server verifies the resulting ID token and that
 * its phone number matches the pending record. Defaults ON. Set
 * CONFIRM_OTP_ENABLED=false to fall back to token-only confirmation (e.g. before
 * Phone Auth is enabled / billed on the project).
 */
const OTP_ENABLED = String(process.env.CONFIRM_OTP_ENABLED || 'true').toLowerCase() !== 'false';

/**
 * Testing only. When true the page sets appVerificationDisabledForTesting, which
 * bypasses the reCAPTCHA app check so a Firebase TEST phone number + fixed code
 * verifies without a real reCAPTCHA or SMS. MUST be false in production — it
 * turns off the anti-abuse gate. Off by default.
 */
const OTP_TEST_MODE = String(process.env.CONFIRM_OTP_TEST_MODE || 'false').toLowerCase() === 'true';

function linkFor(token) {
    return `${PUBLIC_BASE_URL}?t=${encodeURIComponent(token)}`;
}

/* ------------------------------------------------------------------ *
 * Solar Super Hero certificate
 * ------------------------------------------------------------------ */

/** One certificate per customer, keyed by their uid. */
const HERO_COLLECTION = process.env.HERO_COLLECTION || 'hero_certificates';

/**
 * Storage prefix for the rendered files.
 *
 * Under a dedicated prefix rather than beside the points-claim photographs so
 * a Storage rule can grant a customer read access to their own certificate
 * without widening anything else.
 */
const HERO_STORAGE_PREFIX = process.env.HERO_STORAGE_PREFIX || 'hero-certificates';

/**
 * Bucket for the rendered files. Defaults to the project's own, which is what
 * the app and the portal already read.
 */
const HERO_BUCKET = process.env.HERO_BUCKET || '';

/**
 * Who signs the certificate.
 *
 * The artwork shipped with `[Name of Signatory]` / `[Designation]` in it.
 * Blanks here are NOT rendered as those placeholders - `signatoryLines()`
 * drops the signature block entirely rather than printing a square bracket on
 * a document a customer may frame. Set both to turn it on.
 */
const HERO_SIGNATORY_NAME = process.env.HERO_SIGNATORY_NAME || '';
const HERO_SIGNATORY_DESIGNATION = process.env.HERO_SIGNATORY_DESIGNATION || '';

/**
 * Where the QR and the printed line point.
 *
 * `{n}` is replaced with the certificate number. The artwork's own
 * `festonsev.com/verify` is deliberately NOT the default: that page does not
 * exist yet, and a QR that leads nowhere is worse than no QR. Until Feston
 * supply a real verification page this defaults to blank, and a blank verify
 * URL drops the QR and the "Verify at" line rather than printing a dead link.
 */
const HERO_VERIFY_URL_TEMPLATE = process.env.HERO_VERIFY_URL_TEMPLATE || '';

/** The verify URL for one certificate number, or '' when not configured. */
function heroVerifyUrl(certificateNumber) {
    if (!HERO_VERIFY_URL_TEMPLATE) return '';
    return HERO_VERIFY_URL_TEMPLATE.replace('{n}', encodeURIComponent(certificateNumber));
}

/** Collection the Firebase "Trigger Email" extension watches. */
const MAIL_COLLECTION = process.env.MAIL_COLLECTION || 'mail';

/** From: address on the certificate email. Blank lets the extension default. */
const HERO_MAIL_FROM = process.env.HERO_MAIL_FROM || '';

/** Master switch, so the whole feature can be turned off without a rollback. */
const HERO_ENABLED = process.env.HERO_ENABLED !== 'false';

/** Send the certificate email. Off leaves the certificate itself working. */
const HERO_EMAIL_ENABLED = process.env.HERO_EMAIL_ENABLED !== 'false';

module.exports = {
    PENDING_COLLECTION,
    REGISTRATIONS_COLLECTION,
    SERIALS_COLLECTION,
    PUBLIC_BASE_URL,
    LOGO_URL,
    FIREBASE_WEB_CONFIG,
    OTP_ENABLED,
    OTP_TEST_MODE,
    TTL_MINUTES,
    TTL_HOURS,
    linkFor,
    HERO_COLLECTION,
    HERO_STORAGE_PREFIX,
    HERO_BUCKET,
    HERO_SIGNATORY_NAME,
    HERO_SIGNATORY_DESIGNATION,
    HERO_VERIFY_URL_TEMPLATE,
    heroVerifyUrl,
    MAIL_COLLECTION,
    HERO_MAIL_FROM,
    HERO_ENABLED,
    HERO_EMAIL_ENABLED,
};
