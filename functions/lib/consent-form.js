'use strict';

/**
 * The customer's confirmation form, for Feston support filling it in on a
 * consent call (2026-10-22).
 *
 * The verbal-consent screen in the portal used to show its own short summary.
 * It now shows exactly what the customer would have seen on their link: the
 * same sections, built by the same code as the confirm page
 * (`buildDetailsFromRegistration` → `toDisplaySections`), and the same three
 * confirmations, word for word, so support reads out the customer's form
 * rather than a paraphrase of it.
 *
 * POST ?action=consent-form  { token }  — Feston staff only (verbal-consent's
 * own staff check). Unlike the public page it answers for an expired link: a
 * callback is slower than 48 hours, and verbal consent waives the expiry.
 */

const { staffFromToken } = require('./verbal-consent');
const { buildDetailsFromRegistration, toDisplaySections, hasAnyDetail, installPhotosFrom } = require('./snapshot');
const { isExpired } = require('./expiry');

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * The confirmations on the customer's page (lib/page.js renderPendingPage),
 * in its words. `required` ones must be agreed before the registration goes
 * through; marketing stays optional, as it is for the customer.
 */
const CONFIRMATIONS = [
    { key: 'acceptedTerms', required: true, text: 'I have read and agree to the Terms & Conditions and warranty terms.' },
    {
        key: 'acceptedDataForTraining',
        required: true,
        text: 'I agree that Feston may use my registration and product data to improve and train its products and services.',
    },
    {
        key: 'marketingConsent',
        required: false,
        text: 'Send me offers, product updates and service reminders from Feston on WhatsApp, SMS and email. Optional — your warranty is the same either way, and you can ask us to stop at any time.',
    },
];

async function consentForm({ firestore, verifyIdToken, authorization, body, loadPending, logger }) {
    const staff = await staffFromToken({ firestore, verifyIdToken, authorization, logger });
    if (!staff) return { status: 403, body: { status: 'not-staff' } };

    const token = str(body && body.token);
    if (!token) return { status: 400, body: { status: 'bad-request', message: 'token is required' } };

    const pending = await loadPending(token);
    if (!pending) return { status: 404, body: { status: 'not-found' } };

    const details = buildDetailsFromRegistration(pending);
    return {
        status: 200,
        body: {
            status: 'ok',
            linkStatus: str(pending.status) || 'pending',
            expired: isExpired(pending.expiresAt),
            hasDetails: hasAnyDetail(details),
            sections: toDisplaySections(details),
            // The engineer's photos, as on the customer's page (2026-10-23).
            photos: installPhotosFrom(pending),
            confirmations: CONFIRMATIONS,
        },
    };
}

module.exports = { consentForm, CONFIRMATIONS };
