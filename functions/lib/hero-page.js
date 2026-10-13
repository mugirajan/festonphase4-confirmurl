'use strict';

/**
 * The certificate's web page — `confirm?action=hero&n=<number>`.
 *
 * One certificate, shown as the customer holds it, with every rendered file
 * offered underneath: the landscape artwork, the portrait copy to frame, and
 * the 1080×1920 story for Instagram or WhatsApp status. Reached from the
 * certificate email, from the QR on the certificate once the verify URL is
 * configured to point here, and by anyone a customer shows the number to.
 *
 * Same shell, type and colours as the confirm page (lib/page.js): the customer
 * met this service on the day they went solar, and this is the same place.
 *
 * Nothing on this page comes from anywhere but the certificate document, and
 * the only free-text field on that is the customer's name, which is escaped.
 */

const { escapeHtml } = require('./format');
const { shell } = require('./page');
const { formatIssueDate } = require('./hero-certificate');
const { availableVariants, fileFor } = require('./hero-serve');

/** The relative URL of one file. Same page, different query — no origin baked in. */
function fileHref(certificateNumber, variant, download) {
    const base = `?action=hero-file&n=${encodeURIComponent(certificateNumber)}&f=${encodeURIComponent(variant)}`;
    return download ? `${base}&dl=1` : base;
}

const STYLE = `
<style>
  .cert-figure { margin: 0; }
  .cert-figure img {
    display: block; width: 100%; height: auto; border-radius: 8px;
    border: 1px solid var(--hairline); background: #FBF8F1;
  }
  .cert-meta { margin: 14px 0 0; text-align: center; color: var(--ink-muted); font-size: 13px; line-height: 1.6; }
  .cert-meta strong { color: var(--ink); font-weight: 600; }
  .downloads { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
  .downloads a {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 13px 14px; border-radius: 10px; border: 1px solid var(--hairline);
    background: #fff; color: var(--ink); font-size: 14px; font-weight: 500; text-decoration: none;
  }
  .downloads a:hover { border-color: #0d54a9; color: #0d54a9; }
  .downloads a span.tag { font-size: 11px; letter-spacing: .5px; text-transform: uppercase; color: var(--ink-muted); white-space: nowrap; }
  .impact { margin: 0; font-size: 15px; line-height: 24px; color: var(--ink); }
  .impact strong { color: #0d54a9; font-weight: 600; }
</style>`;

/**
 * The page for one certificate.
 *
 * A certificate still `rendering` (the second or two between the record and
 * its files) or in `error` shows its facts and says the files are on their
 * way, rather than a broken image. The page is never cached, so a refresh is
 * all it takes once they exist.
 */
function renderHeroPage({ certificate, logoUrl }) {
    const number = String(certificate.certificateNumber || '');
    const name = String(certificate.customerName || '');
    // A missing issue date prints nothing, never the epoch.
    const issuedAt = certificate.issuedAt && typeof certificate.issuedAt.toDate === 'function'
        ? certificate.issuedAt.toDate()
        : certificate.issuedAt;
    const issued = issuedAt ? formatIssueDate(issuedAt) : '';
    const ready = certificate.status === 'ready';
    const preview = ready && fileFor(certificate, 'png');
    const files = ready ? availableVariants(certificate) : [];

    const picture = preview
        ? `<figure class="cert-figure">
    <img src="${escapeHtml(fileHref(number, 'png', false))}" alt="Solar Super Hero certificate for ${escapeHtml(name)}" />
  </figure>`
        : `<div class="centred">
    <div class="status-icon status-ok">&#9203;</div>
    <h2>Being prepared</h2>
    <p>This certificate has been issued and its files are being rendered. Refresh in a moment.</p>
  </div>`;

    const downloads = files.length
        ? `<div class="card">
  <h2 class="section-title">Download</h2>
  <ul class="downloads">
    ${files
        .map(
            ({ variant, label }) => `<li><a href="${escapeHtml(fileHref(number, variant, true))}" download>
      <span>${escapeHtml(label)}</span><span class="tag">${variant.endsWith('pdf') ? 'PDF' : 'PNG'}</span>
    </a></li>`,
        )
        .join('\n    ')}
  </ul>
</div>`
        : '';

    const body = `
<h1>Solar Super Hero</h1>
<div class="rule"></div>
<p class="lede">Feston SEV confirms that <strong>${escapeHtml(name)}</strong> has gone solar with a genuine Feston system.</p>

<div class="card">
  ${picture}
  <p class="cert-meta">
    Certificate No. <strong>${escapeHtml(number)}</strong>${issued ? ` &middot; Issued on <strong>${escapeHtml(issued)}</strong>` : ''}
  </p>
</div>

<div class="card">
  <h2 class="section-title">Impact</h2>
  <p class="impact">This rooftop solar system offsets an estimated
    <strong>${escapeHtml(certificate.co2Tonnes)} tonnes of CO<sub>2</sub></strong> every year,
    the same as planting about <strong>${escapeHtml(certificate.trees)} trees</strong>.</p>
</div>

${downloads}
${STYLE}`;

    return shell({ title: `Solar Super Hero ${number} — Feston`, logoUrl, body });
}

module.exports = { renderHeroPage, fileHref };
