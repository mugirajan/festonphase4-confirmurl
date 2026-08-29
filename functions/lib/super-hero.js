'use strict';

/**
 * Solar Super Hero — the recognition certificate a customer earns by going
 * solar, issued the moment their registration is confirmed.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * EVERY confirmed registration earns one, whatever the system size. That is the
 * point of it: a 2kW rooftop is the same step towards clean energy as a 50kW
 * one, and a recognition that scaled with kW would be a sales league table
 * rather than a thank-you. There is deliberately no threshold here to tune.
 *
 * ── Where it sits in the flow ───────────────────────────────────────────────
 * After consent and after OTP. `completeRegistration` calls this inside its
 * transaction, so a certificate exists if and only if a registration does —
 * the customer has accepted the terms, verified their phone, and the
 * registration is written. It cannot be issued for an abandoned confirm.
 *
 * ── What this file does NOT do ──────────────────────────────────────────────
 * It does not render a PDF and it does not send mail. It writes two documents:
 * the certificate record, and one queued email. Rendering happens where the
 * customer sees it (the mobile app's profile, which already builds
 * certificates), and sending happens in the Firebase Trigger Email extension —
 * see the warning on `queueSuperHeroEmail`.
 */

const admin = require('firebase-admin');

/** Collection holding one document per issued certificate. */
const CERTIFICATES = 'certificates';

/**
 * The queue the Firebase "Trigger Email" extension watches.
 *
 * ⚠ THE EXTENSION IS NOT INSTALLED ON feston-prod. Checked 2026-08-27: this
 * collection does not exist, and nothing in any of the three repos sends mail.
 * Documents written here are a correctly-shaped QUEUE and nothing more — they
 * will sit unread until somebody installs `firestore-send-email` and points it
 * at an SMTP account.
 *
 * Writing them now rather than later is deliberate: the moment the extension is
 * installed, every certificate issued in the meantime is already queued and
 * goes out. The alternative — adding nodemailer and hard-coding credentials
 * into a Cloud Function — puts an SMTP password in a repo the web team shares.
 */
const MAIL_QUEUE = 'mail';

/** Human-facing name of the award, used in the record and the email. */
const AWARD_NAME = 'Solar Super Hero';

/**
 * A stable, human-readable certificate number: FSSH-00001, FSSH-00002, …
 *
 * Derived from a counter document rather than a collection count, because a
 * count is a read of every document and would grow the transaction without
 * bound. `tx.get` on the counter inside the caller's transaction makes the
 * increment atomic — two registrations confirmed in the same second cannot take
 * the same number.
 */
async function nextSequenceNo(tx, firestore) {
    const counterRef = firestore.collection('counters').doc('solar_super_hero');
    const snap = await tx.get(counterRef);
    const next = ((snap.exists && Number(snap.data().value)) || 0) + 1;
    tx.set(counterRef, { value: next }, { merge: true });
    return `FSSH-${String(next).padStart(5, '0')}`;
}

/**
 * Write the certificate record and queue its email, inside the caller's
 * transaction.
 *
 * Returns the record so the confirm response can carry the number straight back
 * to the page the customer is looking at.
 *
 * @param tx           the Firestore transaction from completeRegistration
 * @param firestore    admin.firestore()
 * @param registration { id, customerName, customerEmail, serialnumber, ... }
 */
async function issueSuperHero(tx, firestore, registration) {
    const sequenceNo = await nextSequenceNo(tx, firestore);
    const certRef = firestore.collection(CERTIFICATES).doc();

    const record = {
        sequenceNo,
        award: AWARD_NAME,
        registrationId: registration.id || '',
        userId: registration.userId || '',
        customerName: registration.customerName || '',
        customerEmail: registration.customerEmail || '',
        serialnumber: registration.serialnumber || '',
        installationDate: registration.installationDate || '',
        // Recorded but NEVER used to decide eligibility — see the rule at the
        // top. It is here so the certificate can show what was installed, not
        // so a future change can gate on it.
        capacityKw: registration.capacityKw || null,
        issuedAt: admin.firestore.FieldValue.serverTimestamp(),
        issuedBy: 'confirm-service',
    };

    tx.set(certRef, record);
    const mailDocId = queueSuperHeroEmail(tx, firestore, { ...record, id: certRef.id });

    // The mail id travels out so the caller can SEND it after the transaction
    // commits. Sending inside would be wrong twice over: a transaction can
    // retry, which would send the congratulation two or three times, and an
    // SMTP timeout would roll back a registration that was otherwise fine.
    return { id: certRef.id, mailDocId, ...record };
}

/**
 * Queue the congratulation email.
 *
 * Shape is the Firebase Trigger Email extension's: a `to` address and a
 * `message` with subject/text/html. No attachment — the certificate is a link
 * back into the app, because attaching a PDF would mean rendering one here, and
 * the renderer lives in the mobile app where the customer can also share it.
 *
 * Silently skipped when there is no email address. A registration without one
 * is legitimate (an installer can register for a customer who gave only a
 * phone), and a missing address must not fail the registration that earned it.
 */
function queueSuperHeroEmail(tx, firestore, cert) {
    const to = (cert.customerEmail || '').trim();
    if (!to) return null;

    const name = (cert.customerName || '').trim() || 'there';
    const subject = `You are a ${AWARD_NAME}! Certificate ${cert.sequenceNo}`;

    const text = [
        `Hi ${name},`,
        '',
        `Your solar installation is registered, and you are officially a ${AWARD_NAME}.`,
        '',
        `Certificate number: ${cert.sequenceNo}`,
        cert.serialnumber ? `Product serial: ${cert.serialnumber}` : '',
        '',
        'Every rooftop counts. Whatever the size of your system, you have moved a',
        'step closer to clean energy — and so has everyone downstream of it.',
        '',
        'Open the Feston app to view, download or share your certificate.',
        '',
        'Thank you,',
        'Feston',
    ]
        .filter(line => line !== '')
        .join('\n');

    const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
  <div style="background:#0063b0;color:#fff;padding:28px 24px;text-align:center">
    <div style="font-size:13px;letter-spacing:2px;opacity:.85">FESTON</div>
    <div style="font-size:26px;font-weight:bold;margin-top:8px">${AWARD_NAME}</div>
  </div>
  <div style="padding:24px">
    <p>Hi ${escapeHtml(name)},</p>
    <p>Your solar installation is registered, and you are officially a
       <strong>${AWARD_NAME}</strong>.</p>
    <p style="background:#e6f0f9;padding:14px 16px;border-radius:6px">
      Certificate number: <strong>${escapeHtml(cert.sequenceNo)}</strong>
      ${cert.serialnumber ? `<br />Product serial: ${escapeHtml(cert.serialnumber)}` : ''}
    </p>
    <p>Every rooftop counts. Whatever the size of your system, you have moved a
       step closer to clean energy — and so has everyone downstream of it.</p>
    <p>Open the Feston app to view, download or share your certificate.</p>
    <p style="margin-top:28px">Thank you,<br />Feston</p>
  </div>
</div>`.trim();

    const mailRef = firestore.collection(MAIL_QUEUE).doc();
    tx.set(mailRef, {
        to,
        message: { subject, text, html },
        // Ours, not the extension's — so a queued mail can be traced back to the
        // certificate it belongs to without matching on the subject line.
        certificateId: cert.id,
        sequenceNo: cert.sequenceNo,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return mailRef.id;
}

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => {
        switch (ch) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            default: return '&#39;';
        }
    });
}

module.exports = {
    issueSuperHero,
    nextSequenceNo,
    queueSuperHeroEmail,
    escapeHtml,
    AWARD_NAME,
    CERTIFICATES,
    MAIL_QUEUE,
};
