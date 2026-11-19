'use strict';

/**
 * Email OTP for the portal's company self-registration (2026-11-18).
 *
 * `/company-register` creates the applicant's Firebase Auth account first and
 * then has to prove the email is theirs. Firebase itself only offers a link;
 * Feston wants a 6-digit code typed into the page. This is that code:
 *
 *   op "send"   — makes a code, stores only its hash, emails it;
 *   op "verify" — checks the typed code and, when it matches, marks the
 *                 account's email as verified with the Admin SDK.
 *
 * The caller is always the applicant, signed in: the ID token names the
 * account and the address, so a code can only be sent to, and can only verify,
 * the caller's own email. `email_verified` on the account is what the Firestore
 * rule for `company_applications` checks, so nothing else has to trust this.
 *
 * Limits: a code lives 10 minutes, dies after 5 wrong tries, and a new one can
 * be requested once a minute, 6 times an hour.
 */

const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { getTransport, smtpConfig } = require('./mailer');

const COLLECTION = 'email_otps';
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_WAIT_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 6;
const MAX_TRIES = 5;

const hashOf = (uid, code) => crypto.createHash('sha256').update(`${uid}:${code}`).digest('hex');
const reply = (status, body) => ({ status, body });

function mailHtml(code) {
    return [
        '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1f2937">',
        '<h2 style="color:#0d54a9;margin:0 0 12px">Feston installer company registration</h2>',
        '<p style="margin:0 0 16px">Use this code to verify your email address:</p>',
        `<p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:0 0 16px">${code}</p>`,
        '<p style="margin:0 0 8px">The code is valid for 10 minutes.</p>',
        '<p style="margin:0;color:#6b7280;font-size:13px">If you did not start a registration with Feston, ignore this email.</p>',
        '</div>',
    ].join('');
}

async function callerOf(authorization) {
    const m = /^Bearer\s+(.+)$/i.exec(String(authorization || ''));
    if (!m) return null;
    try {
        const t = await admin.auth().verifyIdToken(m[1]);
        return t && t.uid && t.email ? { uid: t.uid, email: String(t.email).toLowerCase() } : null;
    } catch {
        return null;
    }
}

async function send(caller) {
    const transport = getTransport();
    if (!transport) return reply(503, { status: 'no-mail', message: 'Email is not set up on this server, so a code cannot be sent.' });

    const ref = admin.firestore().collection(COLLECTION).doc(caller.uid);
    const now = Date.now();
    const prev = (await ref.get()).data() || {};
    const lastSent = Number(prev.sentAtMs) || 0;
    if (now - lastSent < RESEND_WAIT_MS) {
        const wait = Math.ceil((RESEND_WAIT_MS - (now - lastSent)) / 1000);
        return reply(429, { status: 'wait', message: `A code was just sent. You can ask for another in ${wait} seconds.` });
    }
    const recent = (Array.isArray(prev.sends) ? prev.sends : []).filter((t) => now - Number(t) < 60 * 60 * 1000);
    if (recent.length >= MAX_SENDS_PER_HOUR) {
        return reply(429, { status: 'limit', message: 'Too many codes requested. Please try again in an hour.' });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await ref.set({
        email: caller.email,
        hash: hashOf(caller.uid, code),
        expiresAtMs: now + CODE_TTL_MS,
        sentAtMs: now,
        sends: [...recent, now],
        tries: 0,
    });

    try {
        await transport.sendMail({
            from: smtpConfig().from,
            to: caller.email,
            subject: `${code} is your Feston verification code`,
            text: `Your Feston verification code is ${code}. It is valid for 10 minutes. If you did not start a registration with Feston, ignore this email.`,
            html: mailHtml(code),
        });
    } catch (err) {
        console.error('company-email-otp: send failed —', err.message);
        // Let them ask again straight away; this attempt reached nobody.
        await ref.set({ sentAtMs: 0, hash: '', expiresAtMs: 0 }, { merge: true }).catch(() => {});
        return reply(502, { status: 'send-failed', message: 'The code could not be emailed. Check the address and try again.' });
    }
    return reply(200, { status: 'sent' });
}

async function verify(caller, codeRaw) {
    const code = String(codeRaw || '').replace(/\D/g, '');
    if (code.length !== 6) return reply(400, { status: 'bad-code', message: 'Enter the 6-digit code from the email.' });

    const ref = admin.firestore().collection(COLLECTION).doc(caller.uid);
    const doc = (await ref.get()).data();
    if (!doc || !doc.hash || doc.email !== caller.email) {
        return reply(400, { status: 'no-code', message: 'No code is waiting for this email. Press Resend code.' });
    }
    if (Date.now() > Number(doc.expiresAtMs)) {
        return reply(400, { status: 'expired', message: 'That code has expired. Press Resend code.' });
    }
    if (Number(doc.tries) >= MAX_TRIES) {
        return reply(429, { status: 'locked', message: 'Too many wrong tries. Press Resend code to get a new one.' });
    }

    const given = Buffer.from(hashOf(caller.uid, code));
    const wanted = Buffer.from(String(doc.hash));
    if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
        await ref.set({ tries: admin.firestore.FieldValue.increment(1) }, { merge: true });
        return reply(400, { status: 'wrong', message: 'That code is not correct. Check the email and try again.' });
    }

    await admin.auth().updateUser(caller.uid, { emailVerified: true });
    await ref.delete().catch(() => {});
    return reply(200, { status: 'verified' });
}

/**
 * @param authorization  the request's Authorization header (`Bearer <ID token>`)
 * @param body           `{ op: 'send' }` or `{ op: 'verify', code }`
 * @returns `{ status, body }` for the HTTP response
 */
async function companyEmailOtp({ authorization, body }) {
    const caller = await callerOf(authorization);
    if (!caller) return reply(401, { status: 'unauthorised', message: 'Your session has ended. Go back and continue again.' });
    const b = body && typeof body === 'object' ? body : {};
    if (b.op === 'send') return send(caller);
    if (b.op === 'verify') return verify(caller, b.code);
    return reply(400, { status: 'bad-request', message: 'Unknown request.' });
}

module.exports = { companyEmailOtp };
