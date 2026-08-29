'use strict';

/**
 * Sending the queued mail.
 *
 * ── Why a queue AND a sender ────────────────────────────────────────────────
 * `super-hero.js` writes each email into the `mail` collection inside the
 * confirm transaction. This drains that queue. Keeping the two apart is not
 * ceremony:
 *
 *   - A Firestore transaction can RETRY. Sending inside one would send the same
 *     congratulation two or three times to the same customer.
 *   - The queue document is the audit trail. When a customer says they never
 *     got it, `delivery.state` says whether we tried and what happened.
 *   - If SMTP is down, the registration still completes. A mail server is not
 *     allowed to fail a warranty registration.
 *
 * ── Credentials ────────────────────────────────────────────────────────────
 * From the environment, never from source. Locally that is `functions/.env`,
 * which is gitignored — this repo is shared with the web team, and a password
 * in git history cannot be un-shared. For the deployed function set the same
 * keys in the Cloud Functions environment.
 *
 * With no SMTP_HOST configured this does nothing and says so. That is the
 * correct behaviour for an environment without mail — the queue simply fills up
 * and drains once credentials exist.
 */

const admin = require('firebase-admin');

let transport = null;
let transportChecked = false;

/** Read config each time, so a deploy-time change does not need a cold start. */
function smtpConfig() {
    return {
        host: process.env.SMTP_HOST || '',
        port: Number(process.env.SMTP_PORT || 465),
        secure: String(process.env.SMTP_SECURE || 'true') === 'true',
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
        from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
    };
}

/**
 * The transport, built once.
 *
 * `nodemailer` is required lazily so a deployment without it — or without any
 * mail configuration — still loads this module and simply skips sending.
 */
function getTransport() {
    if (transportChecked) return transport;
    transportChecked = true;

    const cfg = smtpConfig();
    if (!cfg.host || !cfg.user || !cfg.pass) {
        console.warn('mailer: no SMTP configured — mail will queue but not send.');
        return null;
    }
    try {
        // eslint-disable-next-line global-require
        const nodemailer = require('nodemailer');
        transport = nodemailer.createTransport({
            host: cfg.host,
            port: cfg.port,
            secure: cfg.secure,
            auth: { user: cfg.user, pass: cfg.pass },
        });
    } catch (err) {
        console.error('mailer: nodemailer unavailable —', err.message);
        transport = null;
    }
    return transport;
}

/**
 * Send one queued document and record the outcome on it.
 *
 * NEVER THROWS. It is called after the registration has already committed, and
 * nothing about a mail failure should reach the customer looking at the confirm
 * page — their product IS registered. The failure goes to the document and the
 * log, where it can be found later.
 *
 * @param mailDocId  id in the `mail` collection, from `issueSuperHero`
 */
async function sendQueued(mailDocId) {
    if (!mailDocId) return { sent: false, reason: 'no-doc' };

    const firestore = admin.firestore();
    const ref = firestore.collection('mail').doc(mailDocId);

    try {
        const snap = await ref.get();
        if (!snap.exists) return { sent: false, reason: 'missing' };

        const doc = snap.data() || {};
        // Already handled. Guards against a retried confirm sending twice — the
        // transaction is idempotent, but this path is not inside it.
        if (doc.delivery && doc.delivery.state === 'SUCCESS') {
            return { sent: false, reason: 'already-sent' };
        }

        const tx = getTransport();
        if (!tx) {
            await ref.set(
                { delivery: { state: 'PENDING', info: 'No SMTP configured', attempts: 0 } },
                { merge: true },
            );
            return { sent: false, reason: 'no-smtp' };
        }

        const message = doc.message || {};
        await tx.sendMail({
            from: smtpConfig().from,
            to: doc.to,
            subject: message.subject,
            text: message.text,
            html: message.html,
        });

        await ref.set(
            {
                delivery: {
                    state: 'SUCCESS',
                    // Same field name the Firebase Trigger Email extension uses,
                    // so installing it later reads these as already delivered
                    // instead of sending them again.
                    endTime: admin.firestore.FieldValue.serverTimestamp(),
                    attempts: (doc.delivery && doc.delivery.attempts ? doc.delivery.attempts : 0) + 1,
                },
            },
            { merge: true },
        );
        console.log(`mailer: sent ${doc.to} — ${message.subject}`);
        return { sent: true };
    } catch (err) {
        console.error('mailer: send failed —', err.message);
        // Recorded rather than raised. A customer whose certificate email failed
        // still has a registered product, and telling them otherwise would be a
        // lie about the thing they actually came here to do.
        try {
            await ref.set(
                { delivery: { state: 'ERROR', error: String(err.message).slice(0, 500) } },
                { merge: true },
            );
        } catch {
            /* the document write failed too; the log above is all we have */
        }
        return { sent: false, reason: 'error', error: err.message };
    }
}

module.exports = { sendQueued, getTransport, smtpConfig };
