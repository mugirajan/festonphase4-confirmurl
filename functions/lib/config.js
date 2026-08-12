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

function linkFor(token) {
    return `${PUBLIC_BASE_URL}?t=${encodeURIComponent(token)}`;
}

module.exports = {
    PENDING_COLLECTION,
    REGISTRATIONS_COLLECTION,
    SERIALS_COLLECTION,
    PUBLIC_BASE_URL,
    LOGO_URL,
    FIREBASE_WEB_CONFIG,
    OTP_ENABLED,
    TTL_MINUTES,
    TTL_HOURS,
    linkFor,
};
