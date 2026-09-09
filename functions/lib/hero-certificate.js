'use strict';

/**
 * Solar Super Hero certificate — HTML rendering.
 *
 * The artwork is NOT reproduced in code. `hero-template.html` is the designer's
 * own file with nine `{{token}}` placeholders substituted into it, so a new
 * version of the design can be dropped in without touching this module, and so
 * the thing a customer receives is the thing that was signed off. Read it at
 * require time: it is ~250 KB of embedded fonts and artwork, and re-reading it
 * per render would be pure waste on a warm instance.
 *
 * The page is entirely self-contained — fonts, logo, emblem and QR all inline.
 * That is the same invariant the confirm page holds, and for the same reason: a
 * document carrying a customer's name should not announce them to a third-party
 * font CDN, and it has to render whole with no network when they open the PNG
 * or the PDF six months from now.
 */

const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, 'hero-template.html');
const TEMPLATE = fs.readFileSync(TEMPLATE_PATH, 'utf8');

/** Every token the template declares. A render must supply all of them. */
const TOKENS = [
    'customer_name',
    'issue_date',
    'co2_tonnes',
    'trees',
    'certificate_number',
    'verify_label',
    'qr_svg',
    'signatory_name',
    'signatory_designation',
];

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * "9 September 2026" — the format the artwork already prints.
 *
 * Pinned to Asia/Kolkata rather than the container's clock. A certificate
 * issued at 01:00 IST is dated the day the customer registered in the country
 * they live in, not the previous day in UTC.
 */
function formatIssueDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
    }).format(d);
}

/**
 * The verify URL as printed under the certificate number.
 *
 * Scheme, `www.` and — importantly — the QUERY STRING are all dropped, so the
 * line reads `festonsev.com/verify` exactly as the artwork sets it.
 *
 * The query string is where the certificate number lives, and keeping it turned
 * a one-line label into `festonsev.com/verify?c=FSV-SSH-2026-` wrapped onto a
 * second line, which in turn squeezed the QR column until its caption wrapped
 * too. Nothing is lost by cutting it: the artwork sets this line as prose, not
 * as something to be typed, and the QR beside it carries the full per-certificate
 * URL. The number is already printed in full on the line directly above.
 */
function verifyLabelFor(url) {
    return String(url || '')
        .replace(/[?#].*$/, '')
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/\/+$/, '');
}

/**
 * Substitutes the tokens.
 *
 * Every value except `qr_svg` is HTML-escaped — a customer name is the one
 * field on this page that comes from user input, and it is rendered at 46px in
 * the middle of the document. `qr_svg` is markup by construction (see
 * hero-qr.js, which builds it from a URL we mint) and is injected as-is.
 *
 * Substitution is done in ONE pass over the template rather than a replace per
 * token, so a value that happens to contain `{{trees}}` cannot be re-expanded
 * by a later pass.
 */
function fillTemplate(values, source = TEMPLATE) {
    const needed = TOKENS.filter((t) => source.includes(`{{${t}}}`));
    const missing = needed.filter((t) => values[t] === undefined);
    if (missing.length) {
        throw new Error(`hero certificate: missing token(s) ${missing.join(', ')}`);
    }
    return source.replace(/\{\{(\w+)\}\}/g, (whole, token) => {
        if (!(token in values)) return whole;
        return token === 'qr_svg' ? values[token] : escapeHtml(values[token]);
    });
}

/**
 * Removes an optional region of the artwork, marked in the template as
 * `<!--#name--> ... <!--/#name-->`.
 *
 * Two regions are optional, and both are optional for the same reason: the
 * design was delivered with content nobody has supplied yet. The signature
 * block reads `[Name of Signatory]` and the QR points at a `festonsev.com/verify`
 * page that does not exist.
 *
 * Printing those as-is would put visible placeholder text, and a QR leading to
 * a 404, on a document customers are being invited to show people. Cutting the
 * region is the honest failure mode: the certificate stays true, just quieter,
 * and turns the block back on the day the values are configured. The markers
 * are comments in the designer's file, so a redesign that keeps them keeps this
 * behaviour for free.
 */
function dropRegion(html, name) {
    const open = `<!--#${name}-->`;
    const close = `<!--/#${name}-->`;
    const start = html.indexOf(open);
    if (start < 0) return html;
    const end = html.indexOf(close, start);
    if (end < 0) return html;
    return html.slice(0, start) + html.slice(end + close.length);
}

/**
 * Renders the certificate for one customer.
 *
 * `qrSvg` is passed in rather than generated here so this module stays pure and
 * synchronous — QR encoding is async in the library that does it, and the
 * caller already has to await the render anyway.
 */
function renderHeroCertificateHtml({
    customerName,
    issuedAt,
    co2Tonnes,
    trees,
    certificateNumber,
    verifyUrl,
    qrSvg,
    signatoryName,
    signatoryDesignation,
}) {
    // Cut what we cannot honestly fill in, before deciding which tokens matter.
    let source = TEMPLATE;
    const signed = Boolean(String(signatoryName || '').trim());
    const verifiable = Boolean(String(verifyUrl || '').trim());
    if (!signed) source = dropRegion(source, 'sig');
    if (!verifiable) {
        source = dropRegion(source, 'verify');
        source = dropRegion(source, 'qr');
    }

    return fillTemplate({
        customer_name: customerName,
        issue_date: formatIssueDate(issuedAt),
        co2_tonnes: co2Tonnes,
        trees: trees,
        certificate_number: certificateNumber,
        verify_label: verifyLabelFor(verifyUrl),
        qr_svg: qrSvg,
        signatory_name: signatoryName,
        signatory_designation: signatoryDesignation,
    }, source);
}

module.exports = {
    TOKENS,
    TEMPLATE_PATH,
    escapeHtml,
    formatIssueDate,
    verifyLabelFor,
    fillTemplate,
    dropRegion,
    renderHeroCertificateHtml,
};
