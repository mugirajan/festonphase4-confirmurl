'use strict';

/**
 * The confirmation page.
 *
 * Rendered server-side as a single self-contained document. When OTP is on it
 * additionally loads the Firebase Auth SDK (from gstatic) to run Phone
 * Authentication client-side; that is the one external dependency, and only on
 * the OTP path. The customer opening this link is on a phone, often on mobile
 * data, straight after an installer handed them the screen.
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

/** Firebase JS SDK version loaded from gstatic on the OTP path. */
const FIREBASE_SDK_VERSION = '10.13.2';

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

    .acks { display: grid; gap: 12px; margin: 4px 0 18px; }
    .ack { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; line-height: 1.5; color: #374151; cursor: pointer; }
    .ack input { margin: 2px 0 0; width: 18px; height: 18px; flex: 0 0 auto; accent-color: ${BRAND_BLUE}; }
    .ack a { color: ${BRAND_BLUE}; font-weight: 500; }
    .otp-input {
      width: 100%; text-align: center; letter-spacing: 8px; font-size: 22px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      padding: 12px; border: 1px solid #cbd5e1; border-radius: 10px; margin-bottom: 12px;
    }
    .otp-links { display: flex; justify-content: space-between; margin-top: 12px; }
    button.linkbtn { background: none; border: 0; color: ${BRAND_BLUE}; font-size: 13px; font-weight: 500; cursor: pointer; padding: 6px; font-family: inherit; }
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

/** Masks a phone for display: keeps the last 4 digits, dots the rest. */
function maskPhone(e164) {
    const s = String(e164 || '').replace(/[^\d+]/g, '');
    if (s.replace(/\D/g, '').length < 4) return s || 'your phone';
    return s.slice(0, s.length - 4).replace(/\d/g, '•') + s.slice(-4);
}

/**
 * The live page: details, the two acknowledgements, and confirmation.
 *
 * Both acknowledgements (terms, data-for-training) must be ticked before the
 * primary button enables. With OTP on, the button sends a one-time code via
 * Firebase Phone Auth to the customer's number and the registration is POSTed
 * only after the code is verified (the server re-verifies the ID token). With
 * OTP off it posts straight away. The countdown is a courtesy — the real expiry
 * is re-checked on the server when the request lands.
 */
function renderPendingPage({ details, expiresAt, actionUrl, token, logoUrl, otpEnabled, phoneE164, firebaseConfig }) {
    const remaining = secondsRemaining(expiresAt);
    const otp = !!otpEnabled && !!phoneE164;
    const masked = maskPhone(phoneE164);
    const primaryLabel = otp ? 'Verify phone &amp; register' : 'Confirm and complete registration';
    const disclaimer = otp
        ? 'We will send a one-time code to <strong>' + escapeHtml(masked) + '</strong> to confirm it is you.'
        : 'By confirming, you acknowledge that the details above are correct and belong to you. Your product will be registered to your Feston account.';

    const body = `
<h1>Confirm your registration</h1>
<div class="rule"></div>
<p class="lede">Please check the details below. If everything is correct, accept the two
acknowledgements and continue — your product is registered only after you confirm.</p>

<div class="notice notice-amber" id="expiry-notice">
  This link expires in <strong id="countdown">${escapeHtml(humaniseSeconds(remaining))}</strong>.
</div>

<div class="card" id="details-card">
${renderSections(details)}
</div>

<div class="actions" id="action-area">
  <div class="acks">
    <label class="ack">
      <input type="checkbox" id="ack-terms" />
      <span>I have read and agree to the <a href="${COMPANY_SITE}" target="_blank" rel="noopener">Terms &amp; Conditions</a> and warranty terms.</span>
    </label>
    <label class="ack">
      <input type="checkbox" id="ack-data" />
      <span>I agree that Feston may use my registration and product data to improve and train its products and services.</span>
    </label>
  </div>
  <button class="primary" id="confirm-btn" type="button" disabled>${primaryLabel}</button>
  <p class="disclaimer">${disclaimer}</p>
  <p class="error" id="error-text" hidden></p>
</div>

<div class="actions" id="otp-area" hidden>
  <p class="lede">Enter the 6-digit code sent to <strong>${escapeHtml(masked)}</strong>.</p>
  <input class="otp-input" id="otp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="------" />
  <button class="primary" id="otp-verify-btn" type="button">Verify &amp; register</button>
  <div class="otp-links">
    <button class="linkbtn" id="otp-resend-btn" type="button">Resend code</button>
    <button class="linkbtn" id="otp-back-btn" type="button">Back</button>
  </div>
  <p class="error" id="otp-error" hidden></p>
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
</div>

<div id="recaptcha-container"></div>`;

    const injected =
        `var expiresAtMs = ${Number(toMillis(expiresAt)) || 0};` +
        `var actionUrl = ${JSON.stringify(actionUrl)};` +
        `var token = ${JSON.stringify(token)};` +
        `var OTP_ON = ${otp ? 'true' : 'false'};` +
        `var PHONE = ${JSON.stringify(phoneE164 || '')};` +
        `var FB = ${JSON.stringify(otp ? firebaseConfig : null)};` +
        `var PRIMARY = ${JSON.stringify(otp ? 'Verify phone & register' : 'Confirm and complete registration')};`;

    const imports = otp
        ? `import { initializeApp } from 'https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js';\n` +
          `import { getAuth, RecaptchaVerifier, signInWithPhoneNumber } from 'https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js';\n`
        : '';

    const script =
        `<script type="module">\n` +
        imports +
        injected +
        PAGE_RUNTIME +
        `\n</script>`;

    return shell({ title: 'Confirm your registration — Feston', logoUrl, body, script });
}

/**
 * Client runtime for the pending page. Plain concatenated JS (no template
 * literals) so it can be embedded without escaping. Reads the `var`s injected
 * above it. The Firebase symbols (initializeApp / getAuth / RecaptchaVerifier /
 * signInWithPhoneNumber) are imported only when OTP_ON, and only referenced then.
 */
const PAGE_RUNTIME = `
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var ackTerms = $('ack-terms'), ackData = $('ack-data');
  var btn = $('confirm-btn'), errorText = $('error-text'), countdown = $('countdown');
  var actionArea = $('action-area'), detailsCard = $('details-card'), expiryNotice = $('expiry-notice');
  var doneArea = $('done-area'), lapsedArea = $('lapsed-area');
  var otpArea = $('otp-area'), otpError = $('otp-error'), otpVerifyBtn = $('otp-verify-btn');
  var otpResendBtn = $('otp-resend-btn'), otpBackBtn = $('otp-back-btn'), otpCode = $('otp-code');

  function human(t) {
    var s = Math.max(0, Math.floor(t));
    if (s < 60) return s + (s === 1 ? ' second' : ' seconds');
    var m = Math.floor(s / 60);
    if (m < 60) return m + (m === 1 ? ' minute' : ' minutes');
    var h = Math.floor(m / 60), rem = m % 60;
    var hrs = h + (h === 1 ? ' hour' : ' hours');
    return rem ? hrs + ' ' + rem + (rem === 1 ? ' minute' : ' minutes') : hrs;
  }
  function hideAll() { detailsCard.hidden = true; actionArea.hidden = true; expiryNotice.hidden = true; otpArea.hidden = true; }
  function showLapsed() { hideAll(); lapsedArea.hidden = false; }
  function showDone() { hideAll(); doneArea.hidden = false; }
  function tick() {
    if (!expiresAtMs) return;
    var left = Math.floor((expiresAtMs - Date.now()) / 1000);
    if (left <= 0) { showLapsed(); return; }
    countdown.textContent = human(left);
    setTimeout(tick, 1000);
  }
  tick();

  function bothChecked() { return !!(ackTerms.checked && ackData.checked); }
  function refreshBtn() { btn.disabled = !bothChecked(); }
  ackTerms.addEventListener('change', refreshBtn);
  ackData.addEventListener('change', refreshBtn);
  refreshBtn();

  function fail(el, msg) { el.textContent = msg; el.hidden = false; }
  function register(idToken) {
    var payload = { token: token, acceptedTerms: true, acceptedDataForTraining: true };
    if (idToken) payload.idToken = idToken;
    return fetch(actionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); });
  }
  function done(r) {
    if (r.body && r.body.status === 'completed') { showDone(); return true; }
    if (r.body && r.body.status === 'expired') { showLapsed(); return true; }
    return false;
  }
  function otpMessage(err) {
    var c = (err && err.code) || '';
    if (c.indexOf('invalid-verification-code') >= 0) return 'That code is not correct. Please try again.';
    if (c.indexOf('code-expired') >= 0) return 'That code has expired. Tap Resend code.';
    if (c.indexOf('too-many-requests') >= 0) return 'Too many attempts. Please wait a few minutes and try again.';
    if (c.indexOf('quota') >= 0) return 'The SMS limit was reached. Please try again later.';
    if (c.indexOf('missing-phone') >= 0 || c.indexOf('invalid-phone') >= 0) return 'We could not send a code to the number on file.';
    return (err && err.message) || 'Verification failed. Please try again.';
  }

  function confirmNoOtp() {
    btn.disabled = true; btn.textContent = 'Registering...'; errorText.hidden = true;
    register(null).then(function (r) {
      if (done(r)) return;
      throw new Error((r.body && r.body.message) || 'Could not complete the registration right now.');
    }).catch(function (err) { btn.disabled = false; btn.textContent = PRIMARY; fail(errorText, err.message); });
  }

  var auth = null, verifier = null, confirmation = null;
  function ensureVerifier() {
    if (!auth) { auth = getAuth(initializeApp(FB)); }
    if (!verifier) { verifier = new RecaptchaVerifier(auth, 'recaptcha-container', { size: 'invisible' }); }
    return verifier;
  }
  function sendOtp() {
    errorText.hidden = true; btn.disabled = true; btn.textContent = 'Sending code...';
    var v;
    try { v = ensureVerifier(); } catch (e) { btn.disabled = false; btn.textContent = PRIMARY; fail(errorText, 'Could not start phone verification.'); return; }
    signInWithPhoneNumber(auth, PHONE, v).then(function (res) {
      confirmation = res;
      actionArea.hidden = true; otpArea.hidden = false;
      if (otpCode) { otpCode.value = ''; otpCode.focus(); }
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = PRIMARY;
      fail(errorText, otpMessage(err));
    });
  }
  function verifyOtp() {
    var code = (otpCode.value || '').replace(/\\D/g, '');
    if (code.length < 6) { fail(otpError, 'Enter the 6-digit code.'); return; }
    if (!confirmation) { fail(otpError, 'Please tap Resend code.'); return; }
    otpError.hidden = true; otpVerifyBtn.disabled = true; otpVerifyBtn.textContent = 'Verifying...';
    confirmation.confirm(code)
      .then(function (cred) { return cred.user.getIdToken(); })
      .then(function (idToken) { return register(idToken); })
      .then(function (r) {
        if (done(r)) return;
        throw new Error((r.body && r.body.message) || 'Could not complete the registration.');
      })
      .catch(function (err) { otpVerifyBtn.disabled = false; otpVerifyBtn.textContent = 'Verify & register'; fail(otpError, otpMessage(err)); });
  }

  btn.addEventListener('click', function () {
    if (!bothChecked()) return;
    if (OTP_ON) { sendOtp(); } else { confirmNoOtp(); }
  });
  if (otpVerifyBtn) otpVerifyBtn.addEventListener('click', verifyOtp);
  if (otpResendBtn) otpResendBtn.addEventListener('click', function () { otpArea.hidden = true; actionArea.hidden = false; sendOtp(); });
  if (otpBackBtn) otpBackBtn.addEventListener('click', function () { otpArea.hidden = true; actionArea.hidden = false; btn.disabled = !bothChecked(); btn.textContent = PRIMARY; });
})();`;

/**
 * Already registered — reached by reopening the link after confirming.
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
