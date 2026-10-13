'use strict';

/**
 * Renders a Solar Super Hero certificate — every layout, plus its web page —
 * to files you can open, with no Firebase, no network and no deploy.
 *
 *   node scripts/hero-preview.js --name "Priya Raghavan" --kw 5 --out ../../temp-data
 *
 * Writes hero-<number>.png/.pdf (landscape), -portrait.png/.pdf, -story.png,
 * the HTML behind each, and hero-<number>-page.html (the download page with
 * the image inlined, since there is no function to serve it from).
 *
 * Local Chrome is used unless PUPPETEER_EXECUTABLE_PATH says otherwise.
 */

const fs = require('fs');
const path = require('path');
const { impactFor } = require('../lib/hero-impact');
const { formatNumber } = require('../lib/hero-number');
const { buildQrSvg } = require('../lib/hero-qr');
const { LAYOUTS, renderLayoutHtml } = require('../lib/hero-layouts');
const { renderLayout, closeBrowser } = require('../lib/hero-render');
const { renderHeroPage } = require('../lib/hero-page');
const { HERO_SIGNATORY_NAME, HERO_SIGNATORY_DESIGNATION, heroVerifyUrl } = require('../lib/config');

function arg(flag, fallback) {
    const i = process.argv.indexOf(flag);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

(async () => {
    const name = arg('--name', 'Priya Raghavan');
    const kw = Number(arg('--kw', '5'));
    const outDir = path.resolve(arg('--out', path.join(__dirname, '..', 'hero-preview')));
    const number = formatNumber(2026, Number(arg('--seq', '41')));
    const impact = impactFor(kw);
    // No verify URL configured means no QR and no "Verify at" line, exactly as
    // the real issuer does it - see dropRegion in lib/hero-certificate.js.
    const verifyUrl = heroVerifyUrl(number);

    const values = {
        customerName: name,
        issuedAt: new Date(),
        co2Tonnes: impact.co2Tonnes,
        trees: impact.trees,
        certificateNumber: number,
        verifyUrl,
        qrSvg: verifyUrl ? await buildQrSvg(verifyUrl) : '',
        signatoryName: HERO_SIGNATORY_NAME,
        signatoryDesignation: HERO_SIGNATORY_DESIGNATION,
    };

    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, `hero-${number}`);
    const started = Date.now();
    console.log(`${name} · ${kw} kW → ${impact.co2Tonnes} t CO2 · ${impact.trees} trees`);

    const files = {};
    for (const [layout, geometry] of Object.entries(LAYOUTS)) {
        const suffix = layout === 'landscape' ? '' : `-${layout}`;
        const html = renderLayoutHtml(layout, values);
        fs.writeFileSync(`${base}${suffix}.html`, html);
        const { png, pdf } = await renderLayout(html, geometry);
        fs.writeFileSync(`${base}${suffix}.png`, png);
        console.log(`  ${base}${suffix}.png  ${(png.length / 1024).toFixed(0)} KB`);
        if (pdf) {
            fs.writeFileSync(`${base}${suffix}.pdf`, pdf);
            console.log(`  ${base}${suffix}.pdf  ${(pdf.length / 1024).toFixed(0)} KB`);
        }
        files[layout] = { png, pdf };
    }
    await closeBrowser();

    // The web page, with the landscape PNG inlined so it opens from disk.
    const certificate = {
        certificateNumber: number,
        customerName: name,
        co2Tonnes: impact.co2Tonnes,
        trees: impact.trees,
        issuedAt: new Date(),
        status: 'ready',
        version: 1,
        pngPath: 'x.png',
        pdfPath: 'x.pdf',
        portraitPngPath: 'x-portrait.png',
        portraitPdfPath: 'x-portrait.pdf',
        storyPngPath: 'x-story.png',
    };
    const page = renderHeroPage({ certificate, logoUrl: '' }).replace(
        /src="\?action=hero-file[^"]*"/,
        `src="data:image/png;base64,${files.landscape.png.toString('base64')}"`,
    );
    fs.writeFileSync(`${base}-page.html`, page);
    console.log(`  ${base}-page.html`);
    console.log(`rendered in ${Date.now() - started}ms`);
})().catch((err) => {
    console.error('preview failed:', err.message);
    process.exit(1);
});
