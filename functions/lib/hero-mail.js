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
const { logoAttachment, logoHtml } = require('./mail-logo');

/** Feston's website, in every certificate email (2026-10-22). */
const FESTON_WEBSITE = 'https://festonsev.com/';

/** Brand colours, matching the certificate itself. */
const BRAND = '#055CA7'; // the app's logo blue (theme colors.primary), so emails match it exactly
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

/**
 * What is attached, in one phrase (2026-10-23): "Solar Super Hero certificate",
 * "... and warranty certificate for serial X", "... , warranty certificate and
 * test report for serial X". The body is three lines; the files say the rest.
 */
function attachedPhrase({ warrantySerial, withReport }) {
    if (!warrantySerial) return 'Solar Super Hero certificate';
    return withReport
        ? `Solar Super Hero certificate, warranty certificate and test report for serial ${warrantySerial}`
        : `Solar Super Hero certificate and warranty certificate for serial ${warrantySerial}`;
}

/**
 * The batteries installed with the inverter (2026-10-27): one warranty
 * certificate (and test report) each, attached with the inverter's. The
 * sentence names their serials so the reader can tell the files apart.
 */
function extrasLineFor(extras) {
    const list = (extras || []).filter((e) => e && e.url);
    if (!list.length) return '';
    const serials = list.map((e) => String(e.serial || '').trim()).filter(Boolean);
    const withReports = list.some((e) => e.testReportUrl);
    const what = withReports ? 'warranty certificate and test report' : 'warranty certificate';
    const which = list.length === 1 ? 'the Feston battery' : `each of the ${list.length} Feston batteries`;
    return `Also attached: the ${what} for ${which} installed with it${serials.length ? ` (serial ${serials.join(', ')})` : ''}.`;
}

function extrasAttachments(extras) {
    const out = [];
    for (const e of extras || []) {
        if (!e || !e.url) continue;
        out.push({ filename: e.filename || `Warranty-${e.serial || 'battery'}.pdf`, path: e.url });
        if (e.testReportUrl) out.push({ filename: e.testReportFilename || `Test-Report-${e.serial || 'battery'}.pdf`, path: e.testReportUrl });
    }
    return out;
}

/** Line 1: thanks (or "updated"), and what is attached. */
function openingFor({ isReissue, warrantySerial, withReport }) {
    const what = attachedPhrase({ warrantySerial, withReport });
    const plural = Boolean(warrantySerial);
    return isReissue
        ? `Your ${what} ${plural ? 'are' : 'has been'} updated and attached.`
        : `Thank you for choosing Feston. Your ${what} ${plural ? 'are' : 'is'} attached.`;
}

/** The plain-text alternative. Some people read mail this way; most filters do. */
function textFor({ customerName, certificateNumber, co2Tonnes, trees, isReissue, pageUrl, warrantySerial, withReport = false, extrasLine = '' }) {
    const who = firstName(customerName);
    return [
        who ? `Hello ${who},` : 'Hello,',
        '',
        openingFor({ isReissue, warrantySerial, withReport }),
        `Your rooftop solar offsets about ${co2Tonnes} tonnes of CO2 a year, the same as planting ${trees} trees.`,
        // The public page link ("Portrait and story-size copies") was dropped from the mail on 2026-10-27 at Feston's request.
        `You can also find ${warrantySerial ? 'them' : 'it'} any time in the Feston app.`,
        ...(extrasLine ? [extrasLine] : []),
        '',
        `Certificate No. ${certificateNumber} · Feston S.E.V Pvt. Ltd. · ${FESTON_WEBSITE}`,
    ].join('\n');
}

function htmlFor({ customerName, certificateNumber, co2Tonnes, trees, isReissue, pageUrl, warrantySerial, withReport = false, extrasLine = '' }) {
    const who = escapeHtml(firstName(customerName));
    const opening = escapeHtml(openingFor({ isReissue, warrantySerial, withReport }));

    return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#FBF8F1;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};">
    ${logoHtml()}
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">${who ? `Hello ${who},` : 'Hello,'}</p>
    <h1 style="font-size:24px;line-height:1.25;font-weight:700;color:${BRAND};margin:0 0 16px;">You are a Solar Super Hero</h1>
    <p style="font-size:16px;line-height:1.5;margin:0 0 8px;">${opening}</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 8px;">
      Your rooftop solar offsets about <strong style="color:${BRAND};">${escapeHtml(co2Tonnes)} tonnes of CO<sub>2</sub></strong> a year,
      the same as planting <strong style="color:${BRAND};">${escapeHtml(trees)} trees</strong>.
    </p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 20px;">
      You can also find ${warrantySerial ? 'them' : 'it'} any time in the Feston app.
    </p>
    ${extrasLine ? `<p style="font-size:16px;line-height:1.5;margin:0 0 20px;">${escapeHtml(extrasLine)}</p>` : ''}
    <p style="font-size:13px;line-height:1.5;color:${MUTED};margin:0;">
      Certificate No. ${escapeHtml(certificateNumber)} &middot; Feston S.E.V Pvt. Ltd. &middot; <a href="${FESTON_WEBSITE}" style="color:${BRAND};">festonsev.com</a>
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
    pageUrl = '',
    // The warranty certificate issued with it (2026-10-22): { url, filename, serial }.
    warranty = null,
    // The batteries' certificates (2026-10-27): [{ serial, url, filename, testReportUrl, testReportFilename }].
    extras = [],
}) {
    const recipient = String(to || '').trim();
    if (!recipient) throw new Error('hero mail: a recipient address is required');

    const warrantySerial = warranty && warranty.url ? String(warranty.serial || '') || '-' : '';
    const withReport = Boolean(warranty && warranty.url && warranty.testReportUrl);
    const facts = { customerName, certificateNumber, co2Tonnes, trees, isReissue, pageUrl, warrantySerial, withReport, extrasLine: extrasLineFor(extras) };
    // The Feston wordmark, inline, first (2026-10-27).
    const attachments = [logoAttachment()];
    if (pngUrl) {
        attachments.push({ filename: `${certificateNumber}.png`, path: pngUrl });
    }
    if (pdfUrl) {
        attachments.push({ filename: `${certificateNumber}.pdf`, path: pdfUrl });
    }
    if (warranty && warranty.url) {
        attachments.push({ filename: warranty.filename, path: warranty.url });
    }
    // The factory test report, issued with the warranty (2026-10-23).
    if (warranty && warranty.testReportUrl) {
        attachments.push({ filename: warranty.testReportFilename || 'Test-Report.pdf', path: warranty.testReportUrl });
    }
    attachments.push(...extrasAttachments(extras));

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

/**
 * The warranty-only email (2026-10-22): sent when a registration issues a
 * warranty certificate but the hero certificate has nothing new to say — its
 * figures did not move, so there is no hero email to attach it to.
 */
function buildWarrantyMailDocument({ to, customerName, serialnumber, url, filename, testReportUrl = '', testReportFilename = '', extras = [], hero = null }) {
    const recipient = String(to || '').trim();
    if (!recipient) throw new Error('warranty mail: a recipient address is required');
    const who = firstName(customerName);
    const serial = String(serialnumber || '').trim() || '-';
    const withReport = Boolean(testReportUrl);
    const what = withReport ? 'warranty certificate and factory test report' : 'warranty certificate';
    const extrasLine = extrasLineFor(extras);
    // The customer's Solar Super Hero certificate rides along too (2026-10-27),
    // so every certificate mail carries the whole set: { number, pngUrl, pdfUrl }.
    const heroLine = hero && hero.pdfUrl ? `Your Solar Super Hero certificate (No. ${hero.number}) is attached as well.` : '';
    const text = [
        who ? `Hello ${who},` : 'Hello,',
        '',
        `Thank you for registering your Feston product. Your ${what} for serial ${serial} ${withReport ? 'are' : 'is'} attached.`,
        `You can also find ${withReport ? 'them' : 'it'} any time in the Feston app, under the product.`,
        ...(extrasLine ? [extrasLine] : []),
        ...(heroLine ? [heroLine] : []),
        '',
        `Feston S.E.V Pvt. Ltd. · ${FESTON_WEBSITE}`,
    ].join('\n');
    const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#FBF8F1;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};">
    ${logoHtml()}
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">${who ? `Hello ${escapeHtml(who)},` : 'Hello,'}</p>
    <h1 style="font-size:24px;line-height:1.25;font-weight:700;color:${BRAND};margin:0 0 16px;">Your ${withReport ? 'warranty certificate and test report' : 'warranty certificate'}</h1>
    <p style="font-size:16px;line-height:1.5;margin:0 0 8px;">
      Thank you for registering your Feston product. Your ${escapeHtml(what)} for serial
      <strong style="color:${BRAND};">${escapeHtml(serial)}</strong> ${withReport ? 'are' : 'is'} attached.
    </p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 20px;">You can also find ${withReport ? 'them' : 'it'} any time in the Feston app, under the product.</p>
    ${extrasLine ? `<p style="font-size:16px;line-height:1.5;margin:0 0 20px;">${escapeHtml(extrasLine)}</p>` : ''}
    ${heroLine ? `<p style="font-size:16px;line-height:1.5;margin:0 0 20px;">${escapeHtml(heroLine)}</p>` : ''}
    <p style="font-size:13px;line-height:1.5;color:${MUTED};margin:0;">Feston S.E.V Pvt. Ltd. &middot; <a href="${FESTON_WEBSITE}" style="color:${BRAND};">festonsev.com</a></p>
  </div>
</body>
</html>`;
    const doc = {
        to: [recipient],
        message: {
            subject: who ? `${who}, your Feston warranty certificate` : 'Your Feston warranty certificate',
            text,
            html,
            attachments: [
                logoAttachment(),
                ...(url ? [{ filename, path: url }] : []),
                ...(testReportUrl ? [{ filename: testReportFilename || 'Test-Report.pdf', path: testReportUrl }] : []),
                ...extrasAttachments(extras),
                ...(hero && hero.pngUrl ? [{ filename: `${hero.number}.png`, path: hero.pngUrl }] : []),
                ...(hero && hero.pdfUrl ? [{ filename: `${hero.number}.pdf`, path: hero.pdfUrl }] : []),
            ],
        },
    };
    if (HERO_MAIL_FROM) doc.from = HERO_MAIL_FROM;
    return doc;
}

module.exports = {
    buildWarrantyMailDocument,
    escapeHtml,
    firstName,
    subjectFor,
    textFor,
    htmlFor,
    buildMailDocument,
};
