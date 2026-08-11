'use strict';

/**
 * The confirmation page.
 *
 * Rendered server-side as a single self-contained document — no build step, no
 * framework, no external CSS or fonts. The customer opening this link is on a
 * phone, often on mobile data, straight after an installer handed them the
 * screen; the page has to paint immediately and work with nothing cached.
 *
 * Styling follows the Feston public register page: gold hairline, Feston blue
 * for actions, everything else quiet.
 */

const { escapeHtml, humaniseSeconds } = require('./format');
const { toDisplaySections } = require('./snapshot');
const { secondsRemaining, toMillis } = require('./expiry');

const BRAND_BLUE = '#0d54a9';
const BRAND_BLUE_DARK = '#094391';
const BRAND_GOLD = '#c5a467';

const COMPANY_NAME = 'Feston S.E.V. Pvt. Ltd.';
const COMPANY_ADDRESS =
    'Survey No. 308/1A/5, Chettipedu Village Thandalam Post, Sriperumpudur Taluk,<br />Thandalam, Kancheepuram, Tamil Nadu, 602105';
const COMPANY_SITE = 'https://www.festonsev.com';

function styles() {
    return `
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f7f8fa;
      color: #111827;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .goldband { height: 4px; background: ${BRAND_GOLD}; }
    main { max-width: 640px; margin: 0 auto; padding: 28px 16px 40px; }
    .brand { text-align: center; margin-bottom: 22px; }
    .wordmark {
      font-size: 26px; font-weight: 800; letter-spacing: 3px;
      color: ${BRAND_BLUE}; margin: 0;
    }
    .wordmark img { height: 46px; width: auto; }
    .tagline { margin: 6px 0 0; font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; color: #6b7280; }
    h1 { font-size: 22px; font-weight: 600; text-align: center; margin: 0; }
    .rule { width: 60px; height: 2px; background: ${BRAND_GOLD}; margin: 10px auto 0; }
    .lede { text-align: center; color: #4b5563; font-size: 14px; line-height: 1.55; margin: 14px auto 0; max-width: 30rem; }
    .card {
      background: #fff; border-radius: 12px; padding: 20px;
      box-shadow: 0 1px 2px rgba(16,24,40,.06); border: 1px solid #e5e7eb;
      margin-top: 22px;
    }
    .section + .section { margin-top: 18px; }
    .section-title {
      font-size: 13px; font-weight: 600; color: #111827;
      padding-bottom: 8px; border-bottom: 1px solid #e5e7eb; margin: 0 0 12px;
    }
    dl { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0; }
    dl > div.wide { grid-column: 1 / -1; }
    dt { font-size: 10.5px; letter-spacing: .6px; text-transform: uppercase; color: #6b7280; margin-bottom: 2px; }
    dd { margin: 0; font-size: 14.5px; color: #111827; word-break: break-word; }
    dd.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .5px; }
    @media (max-width: 460px) { dl { grid-template-columns: 1fr; } }

    .notice {
      margin-top: 18px; border-radius: 10px; padding: 12px 14px;
      font-size: 13px; line-height: 1.5;
    }
    .notice-amber { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
    .notice-red { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }

    .actions { margin-top: 22px; }
    button.primary {
      width: 100%; border: 0; border-radius: 10px; cursor: pointer;
      background: ${BRAND_BLUE}; color: #fff; font-size: 15px; font-weight: 600;
      padding: 15px 16px; font-family: inherit;
    }
    button.primary:hover:not(:disabled) { background: ${BRAND_BLUE_DARK}; }
    button.primary:disabled { opacity: .55; cursor: not-allowed; }
    .disclaimer { margin: 12px 2px 0; font-size: 12px; line-height: 1.5; color: #6b7280; text-align: center; }
    .error { margin-top: 10px; font-size: 13px; color: #b91c1c; text-align: center; }

    .status-icon {
      width: 52px; height: 52px; border-radius: 50%; margin: 0 auto 14px;
      display: flex; align-items: center; justify-content: center; font-size: 26px;
    }
    .status-ok { background: rgba(13,84,169,.10); color: ${BRAND_BLUE}; }
    .status-warn { background: #fef3c7; color: #b45309; }
    .centred { text-align: center; }
    .centred h2 { font-size: 18px; margin: 0 0 6px; }
    .centred p { margin: 0 auto; color: #4b5563; font-size: 14px; line-height: 1.6; max-width: 26rem; }

    footer { border-top: 1px solid #e5e7eb; background: #fff; padding: 20px 16px 26px; margin-top: 30px; }
    footer .inner { max-width: 640px; margin: 0 auto; text-align: center; }
    footer .co { font-size: 13.5px; font-weight: 600; color: ${BRAND_BLUE}; margin: 0; }
    footer .addr, footer .terms { font-size: 11.5px; color: #6b7280; line-height: 1.6; margin: 6px 0 0; }
    footer a { color: ${BRAND_BLUE}; font-weight: 500; }
    [hidden] { display: none !important; }
  `;
}

function renderBrand(logoUrl) {
    const mark = logoUrl
        ? `<img src="${escapeHtml(logoUrl)}" alt="Feston" />`
        : 'FESTON';
    return `
    <div class="brand">
      <p class="wordmark">${mark}</p>
      <p class="tagline">Always On</p>
    </div>`;
}

function renderSections(details) {
    return toDisplaySections(details)
        .map(
            (section) => `
      <div class="section">
        <h2 class="section-title">${escapeHtml(section.title)}</h2>
        <dl>
          ${section.rows
              .map(
                  (row) => `<div${row.wide ? ' class="wide"' : ''}>
            <dt>${escapeHtml(row.label)}</dt>
            <dd${row.mono ? ' class="mono"' : ''}>${escapeHtml(row.value)}</dd>
          </div>`,
              )
              .join('\n          ')}
        </dl>
      </div>`,
        )
        .join('\n');
}

function shell({ title, logoUrl, body, script = '' }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)}</title>
<style>${styles()}</style>
</head>
<body>
<div class="goldband"></div>
<main>
${renderBrand(logoUrl)}
${body}
</main>
<footer>
  <div class="inner">
    <p class="co">${escapeHtml(COMPANY_NAME)}</p>
    <p class="addr">${COMPANY_ADDRESS}</p>
    <p class="terms">*For full terms and conditions, visit
      <a href="${COMPANY_SITE}" target="_blank" rel="noopener">www.festonsev.com</a></p>
  </div>
</footer>
${script}
</body>
</html>`;
}

/**
 * The live page: details plus the acknowledgement button.
 *
 * The countdown is a courtesy, not a control — the expiry that actually decides
 * anything is re-checked on the server when the button is pressed. If the clock
 * runs out with the page open, the button disables itself, but a customer whose
 * device clock is wrong is still stopped by the server, not by this script.
 */
function renderPendingPage({ details, expiresAt, actionUrl, token, logoUrl }) {
    const remaining = secondsRemaining(expiresAt);
    const body = `
<h1>Confirm your registration</h1>
<div class="rule"></div>
<p class="lede">Please check the details below. If everything is correct, tap the button
to complete your registration — your product is registered only after you confirm.</p>

<div class="notice notice-amber" id="expiry-notice">
  This link expires in <strong id="countdown">${escapeHtml(humaniseSeconds(remaining))}</strong>.
</div>

<div class="card" id="details-card">
${renderSections(details)}
</div>

<div class="actions" id="action-area">
  <button class="primary" id="confirm-btn" type="button">Confirm and complete registration</button>
  <p class="disclaimer">By confirming, you acknowledge that the details above are correct
  and belong to you. Your product will be registered to your Feston account.</p>
  <p class="error" id="error-text" hidden></p>
</div>

<div id="done-area" hidden>
  <div class="card centred">
    <div class="status-icon status-ok">&#10003;</div>
    <h2>Registration complete</h2>
    <p>Thank you. Your product is now registered and your warranty is being activated.
    It will appear under <strong>My Products</strong> in the Feston app.</p>
  </div>
</div>

<div id="lapsed-area" hidden>
  <div class="card centred">
    <div class="status-icon status-warn">&#9201;</div>
    <h2>This link has expired</h2>
    <p>For your security, confirmation links stay active for a limited time.
    Please ask for a new link from the Feston app.</p>
  </div>
</div>`;

    const script = `<script>
(function () {
  var expiresAtMs = ${Number(toMillis(expiresAt)) || 0};
  var actionUrl = ${JSON.stringify(actionUrl)};
  var token = ${JSON.stringify(token)};

  var btn = document.getElementById('confirm-btn');
  var errorText = document.getElementById('error-text');
  var countdown = document.getElementById('countdown');
  var actionArea = document.getElementById('action-area');
  var detailsCard = document.getElementById('details-card');
  var expiryNotice = document.getElementById('expiry-notice');
  var doneArea = document.getElementById('done-area');
  var lapsedArea = document.getElementById('lapsed-area');

  // Mirrors humaniseSeconds in lib/format.js — the server renders the first
  // value and this takes over from it, so the two must not disagree on how a
  // 48-hour link reads.
  function human(totalSeconds) {
    var s = Math.max(0, Math.floor(totalSeconds));
    if (s < 60) return s + (s === 1 ? ' second' : ' seconds');
    var m = Math.floor(s / 60);
    if (m < 60) return m + (m === 1 ? ' minute' : ' minutes');
    var h = Math.floor(m / 60);
    var rem = m % 60;
    var hours = h + (h === 1 ? ' hour' : ' hours');
    if (!rem) return hours;
    return hours + ' ' + rem + (rem === 1 ? ' minute' : ' minutes');
  }

  function showLapsed() {
    detailsCard.hidden = true;
    actionArea.hidden = true;
    expiryNotice.hidden = true;
    lapsedArea.hidden = false;
  }

  function showDone() {
    detailsCard.hidden = true;
    actionArea.hidden = true;
    expiryNotice.hidden = true;
    doneArea.hidden = false;
  }

  function tick() {
    if (!expiresAtMs) return;
    var left = Math.floor((expiresAtMs - Date.now()) / 1000);
    if (left <= 0) { showLapsed(); return; }
    countdown.textContent = human(left);
    setTimeout(tick, 1000);
  }
  tick();

  btn.addEventListener('click', function () {
    btn.disabled = true;
    btn.textContent = 'Registering\\u2026';
    errorText.hidden = true;

    fetch(actionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
      .then(function (res) {
        if (res.body && res.body.status === 'completed') { showDone(); return; }
        if (res.body && res.body.status === 'expired') { showLapsed(); return; }
        throw new Error((res.body && res.body.message) || 'Could not complete the registration right now.');
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Confirm and complete registration';
        errorText.textContent = err.message || 'Something went wrong. Please try again.';
        errorText.hidden = false;
      });
  });
})();
</script>`;

    return shell({ title: 'Confirm your registration — Feston', logoUrl, body, script });
}

/**
 * Already registered — reached by reopening the link after confirming.
 *
 * The details are shown again on purpose: this is the only record of the
 * registration the customer can reach without logging in, and reopening the
 * link to check what was submitted is a reasonable thing to want to do.
 */
function renderConfirmedPage({ details, logoUrl }) {
    const body = `
<div class="card centred">
  <div class="status-icon status-ok">&#10003;</div>
  <h2>Registration complete</h2>
  <p>This product is already registered — nothing more is needed. It appears under
  <strong>My Products</strong> in the Feston app.</p>
</div>

<div class="card">
${renderSections(details)}
</div>`;
    return shell({ title: 'Registration complete — Feston', logoUrl, body });
}

/**
 * Expired, cancelled, unknown and broken links share a page with no details.
 *
 * Nothing about the registration is rendered here, because a lapsed or invented
 * token should never be a way to read a customer's name and address.
 */
const UNAVAILABLE_COPY = {
    expired: {
        title: 'This link has expired',
        text: 'For your security, confirmation links stay active for a limited time. Please ask for a new link from the Feston app.',
    },
    cancelled: {
        title: 'This link is no longer active',
        text: 'This confirmation link has been cancelled. Please ask for a new link from the Feston app.',
    },
    error: {
        title: 'Something went wrong',
        text: 'We could not load this registration. Please try again in a moment, or contact Feston support if it keeps happening.',
    },
    'not-found': {
        title: 'Link not found',
        text: 'This confirmation link is not valid. Check that you opened the most recent link, or ask for a new one from the Feston app.',
    },
};

function renderUnavailablePage({ reason, logoUrl }) {
    const copy = UNAVAILABLE_COPY[reason] || UNAVAILABLE_COPY['not-found'];
    const icon = reason === 'expired' ? '&#9201;' : '&#9888;';
    const body = `
<div class="card centred">
  <div class="status-icon status-warn">${icon}</div>
  <h2>${escapeHtml(copy.title)}</h2>
  <p>${escapeHtml(copy.text)}</p>
</div>`;
    return shell({ title: `${copy.title} — Feston`, logoUrl, body });
}

module.exports = {
    renderPendingPage,
    renderConfirmedPage,
    renderUnavailablePage,
    renderSections,
};
