'use strict';

/**
 * The certificate email.
 *
 * Delivery is not done here. A document is written to the `mail` collection and
 * something else drains it — `lib/mailer.js` over SMTP today, and the Firebase
 * "Trigger Email" extension if it is ever installed. The shape below satisfies
 * both: they read the same fields and write the same `delivery.state`, so
 * either can send a queued document and neither will re-send one the other
 * already delivered.
 *
 * The queue is also the audit trail. A mail that fails leaves a document with
 * `delivery.state: 'ERROR'` on it, rather than a line in a log that has since
 * rotated away.
 *
 * The certificate travels as an ATTACHMENT, not as an inline image. Mail
 * clients block remote images by default, so an inline certificate would show
 * most customers a grey box; an attachment is a thing they can save, print and
 * forward. Both files go: the PNG is what people share, the PDF is what people
 * print.
 *
 * The body is deliberately plain, table-free HTML with inline styles and a real
 * plain-text alternative. This mail has one job — tell them the certificate is
 * theirs and hand them the file — and every extra flourish is one more thing to
 * render badly in Outlook.
 */

const { HERO_MAIL_FROM } = require('./config');

/** Brand colours, matching the certificate itself. */
const BRAND = '#045CA4';
const INK = '#1D2A3A';
const MUTED = '#5B6673';

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** The first name, for the greeting. Falls back to the whole string. */
function firstName(name) {
    const clean = String(name || '').trim();
    if (!clean) return '';
    return clean.split(/\s+/)[0];
}

/**
 * Subject line.
 *
 * A reissue is a different event from a first issue and says so: the customer
 * already has this certificate, and a second identical subject line reads like
 * a duplicate send rather than news that their impact went up.
 */
function subjectFor({ customerName, isReissue }) {
    const who = firstName(customerName);
    if (isReissue) {
        return who
            ? `${who}, your Solar Super Hero certificate has been updated`
            : 'Your Solar Super Hero certificate has been updated';
    }
    return who
        ? `${who}, you are a Feston Solar Super Hero`
        : 'You are a Feston Solar Super Hero';
}

/** The plain-text alternative. Some people read mail this way; most filters do. */
function textFor({ customerName, certificateNumber, co2Tonnes, trees, isReissue }) {
    const who = firstName(customerName);
    const opening = isReissue
        ? 'Your Solar Super Hero certificate has been updated to include your latest Feston system.'
        : 'Thank you for choosing Feston SEV. Your Solar Super Hero certificate is attached.';
    return [
        who ? `Hello ${who},` : 'Hello,',
        '',
        opening,
        '',
        `Your rooftop solar system offsets an estimated ${co2Tonnes} tonnes of CO2 every year —`,
        `about the same as planting ${trees} trees.`,
        '',
        `Certificate number: ${certificateNumber}`,
        '',
        'The certificate is attached as an image you can share and a PDF you can print.',
        'You can also find it any time in the Feston app, under your profile.',
        '',
        'Feston S.E.V Pvt. Ltd.',
    ].join('\n');
}

function htmlFor({ customerName, certificateNumber, co2Tonnes, trees, isReissue }) {
    const who = escapeHtml(firstName(customerName));
    const opening = isReissue
        ? 'Your Solar Super Hero certificate has been updated to include your latest Feston system.'
        : 'Thank you for choosing Feston SEV. Your Solar Super Hero certificate is attached.';

    return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#FBF8F1;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};">
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">
      ${who ? `Hello ${who},` : 'Hello,'}
    </p>
    <h1 style="font-size:24px;line-height:1.25;font-weight:700;color:${BRAND};margin:0 0 16px;">
      You are a Solar Super Hero
    </h1>
    <p style="font-size:16px;line-height:1.5;margin:0 0 20px;">${escapeHtml(opening)}</p>
    <div style="border-top:1px solid rgba(232,134,42,0.55);border-bottom:1px solid rgba(232,134,42,0.55);padding:16px 0;margin:0 0 20px;">
      <p style="font-size:16px;line-height:1.5;margin:0;">
        Your rooftop solar system offsets an estimated
        <strong style="color:${BRAND};">${escapeHtml(co2Tonnes)} tonnes of CO<sub>2</sub></strong>
        every year, the same as planting about
        <strong style="color:${BRAND};">${escapeHtml(trees)} trees</strong>.
      </p>
    </div>
    <p style="font-size:15px;line-height:1.5;margin:0 0 20px;">
      Your certificate is attached &mdash; a picture you can share, and a PDF you can print.
      You will also find it any time in the Feston app, under your profile.
    </p>
    <p style="font-size:13px;line-height:1.5;color:${MUTED};margin:0 0 4px;">
      Certificate No. ${escapeHtml(certificateNumber)}
    </p>
    <p style="font-size:13px;line-height:1.5;color:${MUTED};margin:0;">
      Feston S.E.V Pvt. Ltd.
    </p>
  </div>
</body>
</html>`;
}

/**
 * Builds the document for the mail collection.
 *
 * `path` on an attachment is a URL the sender fetches at send time — nodemailer
 * and the extension both accept that shape. It is why the caller passes signed
 * URLs rather than the file bytes: a Firestore document is capped at 1 MiB and
 * the PNG alone is comfortably over half of it.
 */
function buildMailDocument({
    to,
    customerName,
    certificateNumber,
    co2Tonnes,
    trees,
    isReissue = false,
    pngUrl,
    pdfUrl,
}) {
    const recipient = String(to || '').trim();
    if (!recipient) throw new Error('hero mail: a recipient address is required');

    const facts = { customerName, certificateNumber, co2Tonnes, trees, isReissue };
    const attachments = [];
    if (pngUrl) {
        attachments.push({ filename: `${certificateNumber}.png`, path: pngUrl });
    }
    if (pdfUrl) {
        attachments.push({ filename: `${certificateNumber}.pdf`, path: pdfUrl });
    }

    const doc = {
        to: [recipient],
        message: {
            subject: subjectFor(facts),
            text: textFor(facts),
            html: htmlFor(facts),
            attachments,
        },
    };
    if (HERO_MAIL_FROM) doc.from = HERO_MAIL_FROM;
    return doc;
}

module.exports = {
    escapeHtml,
    firstName,
    subjectFor,
    textFor,
    htmlFor,
    buildMailDocument,
};
