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

    /**
     * Who the certificate names.
     *
     * "you" rather than a placeholder when the name is missing. The old text
     * greeted with "Hi there," which reads fine as a greeting and badly on a
     * certificate — "This is awarded to there," is nonsense. A registration
     * genuinely can arrive without a name (an installer registering for someone
     * who gave only a phone number), so this is a real case, not a defensive
     * one.
     */
    const name = (cert.customerName || '').trim() || 'you';
    const subject = `You are a ${AWARD_NAME}! Certificate ${cert.sequenceNo}`;

    // The plain-text part, which is what a text-only client shows and what most
    // spam filters read first. Given the same care as the HTML: a message that
    // reads like a stub in plain text looks like a phishing attempt.
    //
    // `filter(Boolean)` is NOT used here — blank lines are the only paragraph
    // breaks plain text has, and stripping them would run it all together. Only
    // the optional serial line is removed, by leaving it out rather than
    // emptying it.
    const text = [
        'FESTON — CERTIFICATE OF RECOGNITION',
        '',
        `                ${AWARD_NAME.toUpperCase()}`,
        '',
        `This is awarded to ${name},`,
        'for choosing solar and moving one step closer to clean energy.',
        'Every rooftop counts — whatever its size.',
        '',
        '------------------------------------------------------------',
        `  Certificate number : ${cert.sequenceNo}`,
        ...(cert.serialnumber ? [`  Product serial     : ${cert.serialnumber}`] : []),
        '------------------------------------------------------------',
        '',
        'Open the Feston app to view, download or share your certificate.',
        '',
        'Thank you for going solar.',
        'Feston',
        '',
        'This certificate was issued automatically when your product',
        'registration was confirmed.',
    ].join('\n');

    const html = buildHtml({ name, cert });

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

/**
 * The certificate, as an email.
 *
 * ── Written for EMAIL CLIENTS, not browsers ─────────────────────────────────
 * Nested tables and inline styles throughout, because Outlook renders with
 * Word's engine: no flexbox, no grid, no external stylesheet, and `div`
 * layouts collapse. Every rule that matters is on the element it affects.
 *
 * NO IMAGES. Most clients block remote images by default, so a logo would
 * usually arrive as a broken box — and `CONFIRM_LOGO_URL` is unset anyway. The
 * wordmark, the rule under it and the medal are all type and borders, so the
 * certificate looks finished the moment it opens, with nothing to load.
 *
 * `border-radius` is ignored by Outlook, which squares the corners. That is a
 * graceful loss: the layout, the colour and the hierarchy all survive.
 *
 * 600px is the long-standing safe width — wider and Outlook's preview pane
 * starts scrolling horizontally.
 */
function buildHtml({ name, cert }) {
    const BLUE = '#0063b0';
    const INK = '#16202b';
    const MUTED = '#5b6b7a';

    // `white-space:nowrap` on every cell in this block.
    //
    // "Certificate number" is a longer label than "Product serial", and its
    // value is monospace, which is wider again — so the table gave the label
    // less room than it needed and broke it across two lines while the serial
    // row sat happily on one. A label that wraps mid-phrase reads as a layout
    // fault on a document meant to look like a certificate.
    const serialRow = cert.serialnumber
        ? `
              <tr>
                <td style="padding:3px 0;color:${MUTED};font-size:13px;white-space:nowrap">Product serial</td>
                <td style="padding:3px 0;color:${INK};font-size:13px;font-weight:bold;text-align:right;white-space:nowrap">
                  ${escapeHtml(cert.serialnumber)}
                </td>
              </tr>`
        : '';

    return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#eef3f7;margin:0;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="width:600px;max-width:100%;background:#ffffff;border-radius:10px;overflow:hidden;
                    border:1px solid #dbe4ec">

        <!-- brand band -->
        <tr>
          <td style="background:${BLUE};padding:26px 32px 22px 32px;text-align:center">
            <div style="color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:5px">FESTON</div>
            <div style="color:#cfe4f6;font-size:10px;letter-spacing:3px;margin-top:4px">ALWAYS ON</div>
          </td>
        </tr>

        <!-- the award -->
        <tr>
          <td style="padding:34px 32px 8px 32px;text-align:center">
            <div style="font-size:34px;line-height:34px">&#9728;&#65039;</div>
            <div style="color:${MUTED};font-size:11px;letter-spacing:3px;margin-top:14px">
              CERTIFICATE OF RECOGNITION
            </div>
            <div style="color:${INK};font-size:30px;font-weight:bold;margin-top:8px;line-height:36px">
              ${AWARD_NAME}
            </div>
            <div style="width:56px;height:3px;background:${BLUE};margin:16px auto 0 auto"></div>
          </td>
        </tr>

        <!-- recipient -->
        <tr>
          <td style="padding:22px 32px 0 32px;text-align:center">
            <div style="color:${MUTED};font-size:13px">This is awarded to</div>
            <div style="color:${BLUE};font-size:23px;font-weight:bold;margin-top:6px">
              ${escapeHtml(name)}
            </div>
          </td>
        </tr>

        <!-- the reason -->
        <tr>
          <td style="padding:20px 40px 0 40px;text-align:center">
            <div style="color:${INK};font-size:15px;line-height:24px">
              for choosing solar and moving one step closer to clean energy.
              Every rooftop counts &mdash; whatever its size.
            </div>
          </td>
        </tr>

        <!-- details -->
        <tr>
          <td style="padding:26px 32px 0 32px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="background:#f4f8fb;border:1px solid #e2ebf3;border-radius:8px;padding:16px 18px">
              <tr>
                <td style="padding:3px 0;color:${MUTED};font-size:13px;white-space:nowrap">Certificate number</td>
                <td style="padding:3px 0;color:${BLUE};font-size:14px;font-weight:bold;text-align:right;white-space:nowrap;font-family:'Courier New',Courier,monospace">
                  ${escapeHtml(cert.sequenceNo)}
                </td>
              </tr>${serialRow}
            </table>
          </td>
        </tr>

        <!-- what next -->
        <tr>
          <td style="padding:26px 32px 8px 32px;text-align:center">
            <div style="color:${MUTED};font-size:14px;line-height:22px">
              Open the Feston app to view, download or share your certificate.
            </div>
          </td>
        </tr>

        <!-- footer -->
        <tr>
          <td style="padding:24px 32px 28px 32px;text-align:center;border-top:1px solid #edf2f6">
            <div style="color:${MUTED};font-size:12px">Thank you for going solar.</div>
            <div style="color:${INK};font-size:13px;font-weight:bold;margin-top:4px">Feston</div>
          </td>
        </tr>
      </table>

      <div style="color:#8c9aa8;font-size:11px;margin-top:14px">
        This certificate was issued automatically when your product registration was confirmed.
      </div>
    </td>
  </tr>
</table>`.trim();
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
