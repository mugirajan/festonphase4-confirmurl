'use strict';

/**
 * Feston — registration confirmation links.
 *
 * The mobile app no longer registers a product itself. When the form is
 * submitted — by an installer on a customer's behalf, or by the customer
 * directly — the app writes a `pending_registrations` document and hands the
 * customer a link to this page. The customer reviews the details in their own
 * browser and taps confirm; *this service* then creates the registration.
 *
 * One HTTPS function:
 *
 *   confirm   GET  ?t=<token>   → the customer-facing HTML page
 *             POST ?t=<token>   → creates the registration, flips the serial
 *
 * The token is the `pending_registrations` document id (the magic-link shape),
 * so it is both the lookup key and the credential. Every rule that matters is
 * enforced here rather than in the page: the expiry is checked against the
 * stored deadline on read and re-checked inside the confirming transaction, and
 * confirming twice returns the first registration rather than making a second.
 *
 * OTP is specified for this flow but not yet implemented — see `verifyOtp` in
 * `handleConfirm` for the seam it drops into. Until then the token alone
 * authorises the write.
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({ origin: true });

admin.initializeApp();

const { LOGO_URL, linkFor, FIREBASE_WEB_CONFIG, OTP_ENABLED, OTP_TEST_MODE } = require('./lib/config');
const { isValidToken } = require('./lib/tokens');
const { isExpired } = require('./lib/expiry');
const { buildDetailsFromRegistration, hasAnyDetail } = require('./lib/snapshot');
const { renderPendingPage, renderConfirmedPage, renderUnavailablePage } = require('./lib/page');
const store = require('./lib/store');
const mailer = require('./lib/mailer');

const asString = (value) => (typeof value === 'string' ? value.trim() : '');

function sendHtml(res, statusCode, html) {
    // Never cached: the same URL renders a live page, a completed page or an
    // expired page depending on when it is opened, and a proxy holding on to
    // the first of those would show a customer stale personal data.
    res.set('Cache-Control', 'no-store, private');
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(statusCode).send(html);
}

function sendJson(res, statusCode, body) {
    res.set('Cache-Control', 'no-store, private');
    return res.status(statusCode).json(body);
}

/**
 * The token, from `?t=`.
 *
 * `?token=` is accepted as an alias so a hand-typed test URL works. Nothing is
 * read from the path: behind the Hosting rewrite the path is always
 * `/app/register/confirm`, and treating a path segment as a token would make
 * the same link behave differently depending on how it was routed.
 */
function tokenFrom(req) {
    return asString(req.query && (req.query.t || req.query.token));
}

exports.confirm = functions.https.onRequest((req, res) => {
    return cors(req, res, async () => {
        const wantsJson = req.method === 'POST';
        const token = tokenFrom(req);

        // Shape-check before the token is used as a document id, so scanning
        // traffic costs a 404 rather than a Firestore read.
        if (!isValidToken(token)) {
            return wantsJson
                ? sendJson(res, 404, { status: 'not-found' })
                : sendHtml(res, 404, renderUnavailablePage({ reason: 'not-found', logoUrl: LOGO_URL }));
        }

        try {
            if (req.method === 'POST') return await handleConfirm(req, res, token);
            if (req.method === 'GET') return await handlePage(res, token);
            return sendJson(res, 405, { error: 'Method Not Allowed' });
        } catch (error) {
            functions.logger.error('confirm failed', error);
            return wantsJson
                ? sendJson(res, 500, { status: 'error', message: 'Request failed' })
                : sendHtml(res, 500, renderUnavailablePage({ reason: 'error', logoUrl: LOGO_URL }));
        }
    });
});

/** GET ?t=<token> — the page the customer opens. */
async function handlePage(res, token) {
    const pending = await store.loadPending(token);

    if (!pending) {
        return sendHtml(res, 404, renderUnavailablePage({ reason: 'not-found', logoUrl: LOGO_URL }));
    }

    const details = buildDetailsFromRegistration(pending);

    if (pending.status === 'completed') {
        return sendHtml(res, 200, renderConfirmedPage({ details, logoUrl: LOGO_URL }));
    }

    if (pending.status && pending.status !== 'pending') {
        return sendHtml(res, 410, renderUnavailablePage({ reason: 'cancelled', logoUrl: LOGO_URL }));
    }

    if (isExpired(pending.expiresAt)) {
        // No details on an expired link — a lapsed token must not stay a way to
        // read someone's name, phone and installation address.
        return sendHtml(res, 410, renderUnavailablePage({ reason: 'expired', logoUrl: LOGO_URL }));
    }

    // An empty record would put a confirm button under a blank page — nobody
    // should be asked to acknowledge nothing.
    if (!hasAnyDetail(details)) {
        functions.logger.error('pending registration has no displayable details', { token });
        return sendHtml(res, 500, renderUnavailablePage({ reason: 'error', logoUrl: LOGO_URL }));
    }

    // Phone for OTP: prefer the E.164 the app stored; fall back to the bare
    // 10-digit with a +91 default. The page sends the OTP to this number.
    const rawContact = asString(pending.customerContact);
    const digits = asString(pending.customerPhone).replace(/\D/g, '');
    const phoneE164 = rawContact || (digits ? '+91' + digits.slice(-10) : '');

    return sendHtml(
        res,
        200,
        renderPendingPage({
            details,
            expiresAt: pending.expiresAt,
            actionUrl: linkFor(token),
            token,
            logoUrl: LOGO_URL,
            otpEnabled: OTP_ENABLED,
            otpTestMode: OTP_TEST_MODE,
            phoneE164,
            firebaseConfig: FIREBASE_WEB_CONFIG,
        }),
    );
}

/**
 * POST ?t=<token> — the customer tapped confirm.
 *
 * OTP goes here. The handoff spec puts a phone verification between the review
 * and the write; when a provider is chosen, verify before calling
 * `completeRegistration` and return 401 on failure. Everything downstream of
 * this point already assumes it may be called more than once.
 */
async function handleConfirm(req, res, token) {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    // Both acknowledgements are required — the page enforces it too, but never
    // trust the page: a registration is a record of consent that was actually given.
    const acknowledgements = {
        acceptedTerms: body.acceptedTerms === true,
        acceptedDataForTraining: body.acceptedDataForTraining === true,
    };
    if (!acknowledgements.acceptedTerms || !acknowledgements.acceptedDataForTraining) {
        return sendJson(res, 400, {
            status: 'acknowledgements-required',
            message: 'Please accept both acknowledgements to continue.',
        });
    }

    // OTP: verify the Firebase phone-auth ID token and take the verified phone
    // FROM the token (never from the client body). store re-checks it against
    // the pending record's customer.
    let verifiedPhone;
    if (OTP_ENABLED) {
        const idToken = asString(body.idToken);
        if (!idToken) {
            return sendJson(res, 401, { status: 'otp-required', message: 'Phone verification is required.' });
        }
        try {
            const decoded = await admin.auth().verifyIdToken(idToken);
            verifiedPhone = asString(decoded && decoded.phone_number);
        } catch (error) {
            functions.logger.warn('confirm: ID token verification failed', error);
            return sendJson(res, 401, { status: 'otp-invalid', message: 'Phone verification failed. Please try again.' });
        }
        if (!verifiedPhone) {
            return sendJson(res, 401, { status: 'otp-invalid', message: 'Phone verification failed. Please try again.' });
        }
    }

    const result = await store.completeRegistration(token, {
        userAgent: asString(req.get('user-agent')),
        verifiedPhone,
        requirePhoneMatch: OTP_ENABLED,
        acknowledgements,
    });

    if (result.status === 'not-found') return sendJson(res, 404, { status: 'not-found' });
    if (result.status === 'expired') return sendJson(res, 410, { status: 'expired' });
    if (result.status === 'cancelled') {
        return sendJson(res, 409, { status: 'cancelled', message: 'This link is no longer active.' });
    }
    if (result.status === 'phone-mismatch') {
        return sendJson(res, 401, {
            status: 'otp-invalid',
            message: 'That code was verified for a different number than the one on this registration.',
        });
    }

    if (result.status === 'invalid') {
        // The app wrote a record with no owner. Nothing the customer can do,
        // and nothing that should be papered over with a partial write.
        functions.logger.error('pending registration cannot be completed', {
            token,
            reason: result.reason,
        });
        return sendJson(res, 422, {
            status: 'error',
            message: 'This registration is incomplete. Please contact Feston support.',
        });
    }

    if (result.serialFlipped === false && result.serialDocId) {
        functions.logger.warn('serial document not found; registered flag not set', {
            serialDocId: result.serialDocId,
            registeredProductId: result.registeredProductId,
        });
    }

    // The Solar Super Hero certificate email.
    //
    // AFTER the transaction, deliberately. A Firestore transaction can retry,
    // and sending inside one would send the same congratulation two or three
    // times to the same customer. Doing it here means the registration is
    // already committed before a mail server is involved at all.
    //
    // Awaited, so the function does not return before the send resolves — a
    // Cloud Function can be frozen the instant it responds, which would leave
    // the mail half-sent. `sendQueued` never throws and never takes long enough
    // to matter: a failure is written to the mail document and logged.
    //
    // Not sent for an `alreadyCompleted` replay — the customer reopening their
    // link should not receive a second certificate.
    if (result.superHeroMailId && !result.alreadyCompleted) {
        const mail = await mailer.sendQueued(result.superHeroMailId);
        // Only a genuine FAILURE is worth a warning. "No SMTP configured" is a
        // deployment state, not a fault — `getTransport` says it once at
        // startup, and repeating it per registration would bury the real
        // failures in an environment that simply has no mail (every test run,
        // and any deployment before the credentials are set).
        if (!mail.sent && mail.reason === 'error') {
            functions.logger.warn('super hero email failed to send', {
                mailDocId: result.superHeroMailId,
                error: mail.error,
                registeredProductId: result.registeredProductId,
            });
        }
    }

    return sendJson(res, 200, {
        status: 'completed',
        alreadyCompleted: !!result.alreadyCompleted,
        registeredProductId: result.registeredProductId || '',
        // So the page can show the number without waiting for the email.
        superHeroCertificate: result.superHeroCertificate || '',
    });
}
