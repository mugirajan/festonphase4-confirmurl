'use strict';

/**
 * `?action=password-reset` — the "Forgot your password?" email, sent by us
 * (2026-10-23).
 *
 * Firebase's own reset email leaves from noreply@<project>.firebaseapp.com in
 * Google's plain default wording, and Gmail was not reliably delivering it.
 * This generates the same reset link with the Admin SDK and sends it through
 * Feston Care's mailbox (lib/mailer), in Feston's words and colours, with the
 * mail queue as the audit trail like every other email the service sends.
 *
 * No sign-in needed — the caller has forgotten their password. The response is
 * the same whether or not the address has a login (`sent` says which), so the
 * app can keep its installer wording without the page itself leaking anything
 * to a stranger: an unknown address gets no email, and nothing else.
 */

const admin = require('firebase-admin');
const { MAIL_COLLECTION, HERO_MAIL_FROM } = require('./config');
const mailer = require('./mailer');
const { logoAttachment, logoHtml } = require('./mail-logo');

const BRAND = '#055CA7';
const INK = '#1D2A3A';
const MUTED = '#5B6673';
const FESTON_WEBSITE = 'https://festonsev.com';

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const reply = (status, body) => ({ status, body });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) =>
        ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
    );
}

function firstName(name) {
    return str(name).split(/\s+/)[0] || '';
}

/** The email: one button, one sentence of why, one of what to do if it wasn't you. */
function buildResetMailDocument({ to, name, link, installer }) {
    const who = firstName(name);
    const hello = who ? `Hello ${who},` : 'Hello,';
    const account = installer ? 'Feston installer account' : 'Feston account';
    const text = [
        hello,
        '',
        `Someone asked to reset the password for your ${account} (${to}). Open this link to choose a new password:`,
        link,
        '',
        'The link works once and expires in an hour.',
        "If you didn't ask for this, you can ignore this email — your password stays as it is.",
        '',
        'Feston S.E.V Pvt. Ltd.',
        FESTON_WEBSITE,
    ].join('\n');
    const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#FBF8F1;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};">
    ${logoHtml()}
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">${escapeHtml(hello)}</p>
    <h1 style="font-size:24px;line-height:1.25;font-weight:700;color:${BRAND};margin:0 0 16px;">Reset your Feston password</h1>
    <p style="font-size:16px;line-height:1.5;margin:0 0 24px;">
      Someone asked to reset the password for your ${escapeHtml(account)}
      (<strong style="color:${BRAND};">${escapeHtml(to)}</strong>). Press the button to choose a new password.
    </p>
    <p style="margin:0 0 24px;">
      <a href="${escapeHtml(link)}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:999px;">Choose a new password</a>
    </p>
    <p style="font-size:14px;line-height:1.5;color:${MUTED};margin:0 0 8px;">The link works once and expires in an hour. If the button does not open, copy this address into your browser:</p>
    <p style="font-size:12px;line-height:1.5;word-break:break-all;margin:0 0 24px;"><a href="${escapeHtml(link)}" style="color:${BRAND};">${escapeHtml(link)}</a></p>
    <p style="font-size:14px;line-height:1.5;color:${MUTED};margin:0 0 24px;">If you didn't ask for this, you can ignore this email — your password stays as it is.</p>
    <p style="font-size:13px;line-height:1.5;color:${MUTED};margin:0;">Feston S.E.V. Pvt. Ltd. &middot; <a href="${FESTON_WEBSITE}" style="color:${BRAND};">festonsev.com</a></p>
  </div>
</body>
</html>`;
    const doc = {
        to: [to],
        message: { subject: 'Reset your Feston password', text, html, attachments: [logoAttachment()] },
    };
    if (HERO_MAIL_FROM) doc.from = HERO_MAIL_FROM;
    return doc;
}

async function passwordReset({ firestore, body, logger, auth = admin.auth(), send = mailer.sendQueued }) {
    const email = str(body && body.email).toLowerCase();
    if (!EMAIL_RE.test(email)) return reply(400, { status: 'bad-request', message: 'A valid email is required.' });
    const installer = Boolean(body && body.installer);

    let user;
    try {
        user = await auth.getUserByEmail(email);
    } catch (error) {
        if (error && error.code === 'auth/user-not-found') return reply(200, { status: 'ok', sent: false });
        throw error;
    }

    const link = await auth.generatePasswordResetLink(email);
    const mailRef = await firestore.collection(MAIL_COLLECTION).add({
        ...buildResetMailDocument({ to: email, name: user.displayName || '', link, installer }),
        passwordResetFor: user.uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const result = await send(mailRef.id);
    if (!result.sent) {
        if (logger) logger.warn('password-reset: the email did not send', { mailDocId: mailRef.id, reason: result.reason, error: result.error });
        // Queued but not delivered (no SMTP, or a send error): the request is
        // recorded, nothing reaches the person. Say so, so the app can fall back
        // to Firebase's own email rather than promise a mail that never comes.
        return reply(503, { status: 'not-sent', reason: result.reason || 'error' });
    }
    return reply(200, { status: 'ok', sent: true });
}

module.exports = { passwordReset, buildResetMailDocument };
