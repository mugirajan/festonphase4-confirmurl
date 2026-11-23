'use strict';

/**
 * Is the customer's email verified? (2026-11-23)
 *
 * A verified customer email is a REQUIREMENT of an install registered by an
 * engineer — it used to be a 10-point bonus (`customer_email_verified`), now
 * retired. The app asks here before it lets the engineer submit, because the
 * answer lives on the customer's Auth record, which no client may read.
 *
 * `POST ?action=customer-email-status` — body `{ customerUid, resend? }`,
 * engineer's ID token required.
 *
 *   200 { status: 'ok', verified, email }      email is masked: r***@gmail.com
 *   200 { status: 'sent', verified: false, email }   resend: the link was emailed
 *   429 { status: 'wait' }                     resend asked again within a minute
 *   503 { status: 'no-mail' }                  resend, but this server has no SMTP
 *
 * The verification link itself is Firebase's own (`generateEmailVerificationLink`),
 * so opening it sets `emailVerified` exactly as the mail sent at sign-up does.
 */

const { findInstallerByUid } = require('./installer-lookup');

const SENDS_COLLECTION = 'email_verify_sends';
const RESEND_WAIT_MS = 60 * 1000;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const reply = (status, body) => ({ status, body });

/** r***@gmail.com — enough for the engineer to tell the customer which inbox. */
function maskEmail(email) {
    const [name, domain] = str(email).split('@');
    if (!name || !domain) return '';
    return `${name[0]}${'*'.repeat(Math.max(2, Math.min(6, name.length - 1)))}@${domain}`;
}

function mailHtml(link) {
    return [
        '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1f2937">',
        '<h2 style="color:#0d54a9;margin:0 0 12px">Verify your email for Feston Care</h2>',
        '<p style="margin:0 0 16px">Your installer is registering your Feston product. Please confirm this is your email address:</p>',
        `<p style="margin:0 0 16px"><a href="${link}" style="background:#0d54a9;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Verify my email</a></p>`,
        '<p style="margin:0;color:#6b7280;font-size:13px">If you are not registering a Feston product, ignore this email.</p>',
        '</div>',
    ].join('');
}

/**
 * @param {object} p
 * @param {FirebaseFirestore.Firestore} p.firestore
 * @param {(token: string) => Promise<{uid: string}>} p.verifyIdToken
 * @param {string} p.authorization
 * @param {object} p.body
 * @param {(uid: string) => Promise<{email?: string, emailVerified?: boolean}>} [p.getUser]
 * @param {(email: string) => Promise<string>} [p.makeLink]
 * @param {() => ({transport: object, from: string} | null)} [p.mail]
 * @param {() => number} [p.clock]
 */
async function customerEmailStatus({ firestore, verifyIdToken, authorization, body, getUser, makeLink, mail, clock, logger }) {
    const bearer = /^Bearer\s+(.+)$/i.exec(str(authorization));
    if (!bearer) return reply(401, { status: 'unauthenticated' });
    let uid = '';
    try {
        uid = str((await verifyIdToken(bearer[1])).uid);
    } catch (error) {
        if (logger) logger.warn('customer-email-status: token verification failed', error);
    }
    if (!uid) return reply(401, { status: 'unauthenticated' });
    const installer = await findInstallerByUid(firestore, uid);
    if (!installer || (installer.data() || {}).active === false) return reply(403, { status: 'not-installer' });

    // The Auth calls default to the Admin SDK; tests pass their own.
    const admin = getUser && makeLink ? null : require('firebase-admin');
    const readUser = getUser || ((u) => admin.auth().getUser(u));
    const linkFor = makeLink || ((e) => admin.auth().generateEmailVerificationLink(e));
    const mailer =
        mail ||
        (() => {
            const { getTransport, smtpConfig } = require('./mailer');
            const transport = getTransport();
            return transport ? { transport, from: smtpConfig().from } : null;
        });
    const nowMs = clock ? clock() : Date.now();

    const b = body && typeof body === 'object' ? body : {};
    const customerUid = str(b.customerUid);
    if (!customerUid) return reply(400, { status: 'bad-request', message: 'Missing customer.' });

    let record = null;
    try {
        record = await readUser(customerUid);
    } catch {
        record = null;
    }
    if (!record) return reply(404, { status: 'no-customer', message: 'This customer has no account.' });
    const email = str(record.email);
    if (!email) return reply(200, { status: 'ok', verified: false, email: '', message: 'This customer has no email address on their account.' });
    const masked = maskEmail(email);
    if (record.emailVerified === true) return reply(200, { status: 'ok', verified: true, email: masked });
    if (b.resend !== true) return reply(200, { status: 'ok', verified: false, email: masked });

    // Resend: once a minute per customer.
    const ref = firestore.collection(SENDS_COLLECTION).doc(customerUid);
    const prev = (await ref.get()).data() || {};
    const since = nowMs - (Number(prev.sentAtMs) || 0);
    if (since < RESEND_WAIT_MS) {
        const wait = Math.ceil((RESEND_WAIT_MS - since) / 1000);
        return reply(429, { status: 'wait', verified: false, email: masked, message: `An email was just sent. You can send another in ${wait} seconds.` });
    }
    const m = mailer();
    if (!m) {
        return reply(503, {
            status: 'no-mail',
            verified: false,
            email: masked,
            message: 'A new email cannot be sent right now. Ask the customer to open the verification email they already received.',
        });
    }
    try {
        const link = await linkFor(email);
        await m.transport.sendMail({
            from: m.from,
            to: email,
            subject: 'Verify your email for Feston Care',
            text: `Your installer is registering your Feston product. Open this link to verify your email address: ${link}`,
            html: mailHtml(link),
        });
    } catch (error) {
        if (logger) logger.error('customer-email-status: resend failed', error);
        return reply(502, { status: 'send-failed', verified: false, email: masked, message: 'The email could not be sent. Please try again.' });
    }
    await ref.set({ sentAtMs: nowMs, by: uid });
    return reply(200, { status: 'sent', verified: false, email: masked, message: `Verification email sent to ${masked}.` });
}

module.exports = { customerEmailStatus, maskEmail };
