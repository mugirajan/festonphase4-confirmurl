'use strict';

/**
 * The certificate in its three shapes.
 *
 *   landscape  A4 landscape, 1123×794. The designer's artwork, untouched
 *              (hero-template.html). PNG + PDF. What the email attaches.
 *   portrait   A4 portrait, 794×1123. PNG + PDF. For the customer who wants
 *              to print and frame it the way certificates usually hang.
 *   story      1080×1920, PNG only. The social post the proposal promised
 *              (slide 15): Instagram / WhatsApp status shape, phone-first.
 *
 * The portrait and story templates do NOT carry their own copies of the fonts,
 * the logo, the emblem, the rose pattern or the ribbon. They borrow them from
 * the landscape file at require time through `{{@name}}` markers, so the three
 * layouts can never drift apart on the brand assets — a new logo dropped into
 * the designer's file reaches all three. The customer tokens (`{{name}}`) and
 * the optional regions (`<!--#sig-->` …) are the same ones hero-certificate.js
 * already handles, so the escaping, the "no placeholder on a framed document"
 * rule and the one-pass substitution all apply unchanged.
 */

const fs = require('fs');
const path = require('path');
const { TEMPLATE, fillTemplate, dropRegion, PRODUCTS_IMAGE_URI } = require('./hero-certificate');

/** Render geometry per layout. `scale` is Chrome's deviceScaleFactor. */
const LAYOUTS = {
    // 2x: the artwork was judged at 2246×1588 and a 1x share image goes soft
    // the moment anyone pinch-zooms it.
    landscape: { width: 1123, height: 794, scale: 2, pdf: true },
    portrait: { width: 794, height: 1123, scale: 2, pdf: true },
    // 1080×1920 IS the target pixel size — Instagram and WhatsApp downscale
    // anything larger — so 1x here is already the native resolution.
    story: { width: 1080, height: 1920, scale: 1, pdf: false },
};

const LAYOUT_NAMES = Object.keys(LAYOUTS);

const TEMPLATE_PATHS = {
    portrait: path.join(__dirname, 'hero-template-portrait.html'),
    story: path.join(__dirname, 'hero-template-story.html'),
};

const SOURCES = {
    portrait: fs.readFileSync(TEMPLATE_PATHS.portrait, 'utf8'),
    story: fs.readFileSync(TEMPLATE_PATHS.story, 'utf8'),
};

/** Drops the fixed `width`/`height` from an `<svg>` opening tag so CSS sizes it. */
function unsizeSvg(svg) {
    return svg.replace(/^(<svg\b[^>]*?)\s(?:width|height)="[^"]*"/i, '$1')
        .replace(/^(<svg\b[^>]*?)\s(?:width|height)="[^"]*"/i, '$1');
}

/**
 * Pulls the brand assets out of the landscape template.
 *
 * Each lookup is anchored on something structural in the designer's file — the
 * `@font-face` rules, the two embedded PNGs in document order (logo first,
 * emblem second), and the two positioned blocks that hold the rose pattern and
 * the ribbon. A redesign that moves those throws here, at require time, rather
 * than silently shipping a portrait certificate with no logo on it.
 */
function extractAssets(source = TEMPLATE) {
    const fonts = (source.match(/@font-face[^\n]*/g) || []).join('\n    ');
    const images = [...source.matchAll(/<img src="(data:image\/png;base64,[^"]+)"/g)].map((m) => m[1]);
    const rose = (source.match(/<div style="position: absolute; left: 480px; top: -230px;[^>]*>\s*(<svg[\s\S]*?<\/svg>)/) || [])[1];
    const ribbon = (source.match(/<div style="position: absolute; left: 858px; top: 0px;[^>]*>\s*(<svg[\s\S]*?<\/svg>)/) || [])[1];

    const missing = [];
    if (!fonts) missing.push('fonts');
    if (images.length < 2) missing.push('logo/emblem');
    if (!rose) missing.push('rose');
    if (!ribbon) missing.push('ribbon');
    if (missing.length) {
        throw new Error(`hero layouts: the landscape template no longer carries ${missing.join(', ')}`);
    }

    return {
        fonts,
        logo: images[0],
        emblem: images[1],
        rose: unsizeSvg(rose),
        ribbon: unsizeSvg(ribbon),
        // The product line-up under the impact sentence (2026-10-22).
        products: PRODUCTS_IMAGE_URI,
    };
}

const ASSETS = extractAssets();

/** `{{@fonts}}` → the asset. Distinct from `{{token}}`: `@` is not a word char. */
function fillAssets(source, assets = ASSETS) {
    return source.replace(/\{\{@(\w+)\}\}/g, (whole, name) => {
        if (!(name in assets)) throw new Error(`hero layouts: unknown asset marker ${whole}`);
        return assets[name];
    });
}

/**
 * The HTML for one layout.
 *
 * Takes the same values as `renderHeroCertificateHtml` and applies the same
 * rules: an unsigned certificate loses its signature block, an unverifiable one
 * loses the QR and the verify line. The landscape layout is delegated to the
 * original renderer so its output stays byte-for-byte what it was.
 */
function renderLayoutHtml(layout, values) {
    if (!(layout in LAYOUTS)) throw new Error(`hero layouts: unknown layout "${layout}"`);
    if (layout === 'landscape') {
        // Lazy require: hero-certificate.js is already loaded above; this is
        // only to keep the landscape path identical to the existing one.
        return require('./hero-certificate').renderHeroCertificateHtml(values);
    }

    let source = fillAssets(SOURCES[layout]);
    const signed = Boolean(String(values.signatoryName || '').trim());
    const verifiable = Boolean(String(values.verifyUrl || '').trim());
    if (!signed) source = dropRegion(source, 'sig');
    if (!verifiable) {
        source = dropRegion(source, 'verify');
        source = dropRegion(source, 'qr');
    }

    const { formatIssueDate, verifyLabelFor } = require('./hero-certificate');
    return fillTemplate(
        {
            customer_name: values.customerName,
            issue_date: formatIssueDate(values.issuedAt),
            co2_tonnes: values.co2Tonnes,
            trees: values.trees,
            certificate_number: values.certificateNumber,
            verify_label: verifyLabelFor(values.verifyUrl),
            qr_svg: values.qrSvg,
            signatory_name: values.signatoryName,
            signatory_designation: values.signatoryDesignation,
        },
        source,
    );
}

module.exports = {
    LAYOUTS,
    LAYOUT_NAMES,
    TEMPLATE_PATHS,
    SOURCES,
    ASSETS,
    extractAssets,
    fillAssets,
    unsizeSvg,
    renderLayoutHtml,
};
