'use strict';

/**
 * Renders a Solar Super Hero certificate to files you can open, with no
 * Firebase, no network and no deploy.
 *
 *   node scripts/hero-preview.js --name "Priya Raghavan" --kw 5 --out ../../temp-data
 *
 * Local Chrome is used unless PUPPETEER_EXECUTABLE_PATH says otherwise.
 */

const fs = require('fs');
const path = require('path');
const { impactFor } = require('../lib/hero-impact');
const { formatNumber } = require('../lib/hero-number');
const { buildQrSvg } = require('../lib/hero-qr');
const { renderHeroCertificateHtml } = require('../lib/hero-certificate');
const { renderCertificate, closeBrowser } = require('../lib/hero-render');
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

    const html = renderHeroCertificateHtml({
        customerName: name,
        issuedAt: new Date(),
        co2Tonnes: impact.co2Tonnes,
        trees: impact.trees,
        certificateNumber: number,
        verifyUrl,
        qrSvg: verifyUrl ? await buildQrSvg(verifyUrl) : '',
        signatoryName: HERO_SIGNATORY_NAME,
        signatoryDesignation: HERO_SIGNATORY_DESIGNATION,
    });

    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, `hero-${number}`);
    fs.writeFileSync(`${base}.html`, html);

    const started = Date.now();
    const { png, pdf } = await renderCertificate(html);
    fs.writeFileSync(`${base}.png`, png);
    fs.writeFileSync(`${base}.pdf`, pdf);
    await closeBrowser();

    console.log(`${name} · ${kw} kW → ${impact.co2Tonnes} t CO2 · ${impact.trees} trees`);
    console.log(`rendered in ${Date.now() - started}ms`);
    console.log(`  ${base}.png  ${(png.length / 1024).toFixed(0)} KB`);
    console.log(`  ${base}.pdf  ${(pdf.length / 1024).toFixed(0)} KB`);
})().catch((err) => {
    console.error('preview failed:', err.message);
    process.exit(1);
});
