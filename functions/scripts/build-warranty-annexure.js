'use strict';

/**
 * Builds the "Annexure to Warranty Certificate" PDF (2026-11-10).
 *
 * Feston supplied the annexure as a finished PDF set in Arial. The customer
 * asked for it in Exo 2 — the face the confirm page and the Solar Super Hero
 * certificate use — and for the battery degradation table to have rows of ONE
 * height (the original's Year 6–10 rows, pushed onto page 2, came out taller
 * than Year 1–5). So the document is laid out here as HTML and rendered by
 * the same headless Chrome that renders the certificates.
 *
 *   node scripts/build-warranty-annexure.js            writes all three copies
 *   node scripts/build-warranty-annexure.js --check    renders, reports, writes nothing
 *
 * Outputs (replace all three together — see lib/warranty-annexure.js):
 *   lib/warranty-annexure.pdf                                    (this service)
 *   ../../feston-care/src/assets/documents/warranty-annexure.pdf (portal)
 *   ../../feston/src/assets/warrantyAnnexure.ts                  (app, base64)
 *
 * Fonts: the Exo 2 TTFs the mobile app bundles (feston/assets/fonts), embedded
 * as data URIs so the render needs no network. Chrome subsets them into the
 * PDF, so the file stays small.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // c:\xampp\htdocs\feston-care
const FONT_DIR = path.join(ROOT, 'feston', 'assets', 'fonts');
const OUT_SERVICE = path.join(__dirname, '..', 'lib', 'warranty-annexure.pdf');
const OUT_PORTAL = path.join(ROOT, 'feston-care', 'src', 'assets', 'documents', 'warranty-annexure.pdf');
const OUT_APP = path.join(ROOT, 'feston', 'src', 'assets', 'warrantyAnnexure.ts');

// Three pages: Exo 2 sets tighter than the Arial original, and the degradation
// table is kept whole on page 1 rather than split with one row orphaned.
const PAGES = 3;

const NAVY = '#0E1E42';
const BRAND = '#055CA7';
const INK = '#1F2937';
const RULE = '#C9D2DE';
const HEAD_BG = '#EEF2F7';

function fontFace(weight, file) {
    const b64 = fs.readFileSync(path.join(FONT_DIR, file)).toString('base64');
    return `@font-face{font-family:'Exo 2';font-style:normal;font-weight:${weight};src:url(data:font/ttf;base64,${b64}) format('truetype');}`;
}

const DEGRADATION = [
    ['Year 1', '≥ 94% of nominal', '600 cycles'],
    ['Year 2', '≥ 90% of nominal', '1,200 cycles'],
    ['Year 3', '≥ 86% of nominal', '1,800 cycles'],
    ['Year 4', '≥ 82% of nominal', '2,400 cycles'],
    ['Year 5', '≥ 80% of nominal', '3,000 cycles'],
    ['Year 6', '≥ 78% of nominal', '3,600 cycles'],
    ['Year 7', '≥ 76% of nominal', '4,200 cycles'],
    ['Year 8', '≥ 74% of nominal', '4,800 cycles'],
    ['Year 9', '≥ 72% of nominal', '5,400 cycles'],
    ['Year 10', '≥ 70% of nominal', '6,000 cycles'],
];

const SLA = [
    ['Tier 1 Metro Centers &amp; Major District HQs', '3–5 Working Days'],
    ['Tier 2 / Other District Capitals', '5–7 Working Days'],
    ['Semi-Urban &amp; Registered Rural Locations', '7–10 Working Days'],
    ['North-Eastern States, J&amp;K, Union Territories &amp; Islands', '10–14 Working Days'],
];

function degradationRows() {
    const baseline = `<td class="baseline" rowspan="${DEGRADATION.length}">
        <p>- Charge/Discharge: 0.5C standard rate.</p>
        <p>- Approved external DC MCCB/Battery Box usage mandatory.</p>
        <p>- Deep discharge state must not exceed 24 hours consecutive</p>
        <p>- Continuous ambient operating limits: 0°C to 45°C.</p>
      </td>`;
    return DEGRADATION.map(
        ([year, cap, cycles], i) =>
            `<tr><td>${year}</td><td>${cap}</td><td>${cycles}</td>${i === 0 ? baseline : ''}</tr>`,
    ).join('\n');
}

function slaRows() {
    const caveats = `<td class="baseline" rowspan="${SLA.length}">
        <p>- Targets are dependent on immediate component stocks.</p>
        <p>- Complex bench-testing or custom factory line processing may extend resolution windows.</p>
        <p>- Freight handling and rural routing schedules are subject to local logistical infrastructure constraints.</p>
      </td>`;
    return SLA.map(([region, days], i) => `<tr><td>${region}</td><td>${days}</td>${i === 0 ? caveats : ''}</tr>`).join('\n');
}

function html() {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Annexure to Warranty Certificate</title>
<style>
${fontFace(400, 'Exo2-Regular.ttf')}
${fontFace(500, 'Exo2-Medium.ttf')}
${fontFace(600, 'Exo2-SemiBold.ttf')}
${fontFace(700, 'Exo2-Bold.ttf')}

@page { size: A4; margin: 16mm 16mm 18mm 16mm; }
html, body { margin: 0; padding: 0; }
body {
  font-family: 'Exo 2', sans-serif;
  font-size: 10pt;
  line-height: 1.4;
  color: ${INK};
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
b, strong { font-weight: 700; }
a { color: ${BRAND}; text-decoration: underline; }

h1 {
  margin: 0 0 4px;
  text-align: center;
  font-size: 19.5pt;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: ${NAVY};
}
.sub {
  margin: 0 0 14px;
  text-align: center;
  font-size: 10.2pt;
  font-weight: 600;
  color: #3F4B5B;
}
h2 {
  margin: 12px 0 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid ${RULE};
  font-size: 11pt;
  font-weight: 700;
  color: ${NAVY};
  break-after: avoid;
  page-break-after: avoid;
}
h3 {
  margin: 8px 0 3px;
  font-size: 10.6pt;
  font-weight: 700;
  color: ${NAVY};
  break-after: avoid;
  page-break-after: avoid;
}
p { margin: 0 0 7px; orphans: 3; widows: 3; }
.spec { color: ${BRAND}; font-weight: 500; margin-bottom: 6px; }

ul, ol { margin: 0 0 7px; padding-left: 22px; }
li { margin: 0 0 5px; padding-left: 2px; }
ul li::marker { color: ${INK}; }
ol.alpha { list-style: lower-alpha; padding-left: 34px; }
ol.alpha li { padding-left: 4px; }

table.grid {
  width: 100%;
  border-collapse: collapse;
  margin: 2px 0 10px;
  font-size: 9.4pt;
}
table.grid th, table.grid td {
  border: 1px solid ${RULE};
  padding: 0 9px;
  text-align: left;
  vertical-align: middle;
}
table.grid th {
  background: ${HEAD_BG};
  font-weight: 700;
  color: ${NAVY};
  height: 32px;
  line-height: 1.25;
}
/* Every data row is the SAME height — the one thing the original got wrong. */
table.grid td { height: 30px; line-height: 1.25; }
/* Rows may split across a page break (the original does); each row is still one height. */
table.grid tr { break-inside: auto; }
table.grid thead { display: table-header-group; }
table.grid td.baseline { vertical-align: top; padding: 8px 9px; }
table.grid td.baseline p { margin: 0 0 4px; font-size: 9.2pt; line-height: 1.3; }
table.degradation col.c1 { width: 19%; }
table.degradation col.c2 { width: 22%; }
table.degradation col.c3 { width: 22%; }
table.sla col.c1 { width: 36%; }
table.sla col.c2 { width: 24%; }

.contact {
  margin-top: 16px;
  padding-top: 8px;
  border-top: 1px solid ${RULE};
  text-align: center;
  font-size: 8.8pt;
  font-weight: 600;
  color: #6B7280;
}
.contact a { color: ${BRAND}; }
</style></head>
<body>

<h1>ANNEXURE TO WARRANTY CERTIFICATE</h1>
<p class="sub">FESTON SEV PVT. LTD. — Standard Manufacturer Warranty Terms &amp; Performance Conditions</p>

<h2>1. REGISTRATION MANDATE &amp; ACTIVATION</h2>
<p>Warranty coverage is strictly contingent upon successful product registration within <b>thirty (30) days</b> from the date of the original purchase invoice. Registration must be executed via the official portal at <a href="https://admin.festonsev.com/register">https://admin.festonsev.com/register</a> or on <b>FESTON CARE APP</b>. Failure to complete registration within this timeframe completely invalidates all claims under this warranty.</p>

<h2>2. SCOPE OF STANDARD WARRANTY COVERAGE</h2>
<ul>
  <li><b>Grid-Tied &amp; Hybrid Inverters:</b> Covered for a fixed term of ten (10) years from the invoice date against verifiable manufacturing and material defects. Remedies are strictly limited to repair or replacement using new or factory-refurbished parts, down to component level, at the sole and absolute discretion of <b>FESTON</b>. Standard exclusions apply to user-facing LCD displays, external plastic/rubber trims, cosmetic degradation, and third-party accessories.</li>
  <li><b>Energy Storage Systems (ESS) / Lithium Batteries:</b> Covered for a standard period of ten (10) years from the invoice date. Integrated Battery Management Systems (BMS) and internal accessories carry a standard coverage of five (5) years unless a specific extension is noted on the invoice datasheet. Remedies comprise repair, component-level replacement, or a linear prorated credit calculated based on the remaining unexpired months of the warranty term. Replaced or repaired components do not extend or restart the original warranty clock.</li>
</ul>

<h2>3. BATTERY PERFORMANCE &amp; DEGRADATION GUARANTEE</h2>
<p><b>FESTON</b> guarantees that the battery module will retain usable energy capacity according to the operational metrics detailed below, strictly evaluated at a 0.5C charge/discharge rate at a standardized reference temperature of 25°C (±2°C). Performance guarantees are null and void if cumulative energy throughput or cycles exceed the specific milestones below, or if the unit is operated outside the prescribed thresholds.</p>
<h3>Testing &amp; Operational Specifications</h3>
<p class="spec">LVB-6000 / LVD-6000: 1C Rate @ 100A; LVC-3500: 0.5C Rate @ 50A; Mandatory connection via approved DC MCCB / Battery Box; Must not remain discharged &gt;48 hours</p>

<table class="grid degradation">
  <colgroup><col class="c1" /><col class="c2" /><col class="c3" /><col class="c4" /></colgroup>
  <thead><tr><th>Year of Operation</th><th>Min. Usable Capacity</th><th>Max. Cumulative Cycles</th><th>Testing &amp; Operation Baseline</th></tr></thead>
  <tbody>
${degradationRows()}
  </tbody>
</table>

<h2>4. TECHNICAL ELIGIBILITY &amp; PROTECTION INFRASTRUCTURE</h2>
<p>To qualify for warranty protection, the complete solar/storage system must be commissioned by a certified installer and must incorporate dedicated electrical safety elements. The minimum mandatory framework includes an AC Distribution Box (ACDB), a DC Distribution Box (DCDB) with adequate Surge Protection Devices (SPD), dedicated DC Molded Case Circuit Breakers (MCCB) sized appropriately for the battery loop, and a certified solid earth ground connection tracking below 5 Ohms. The customer must ensure that firmware updates are kept current and that internal system logs (BMS and inverter data records) are maintained without interruption; deleting or altering system data logs permanently invalidates coverage.</p>

<h2>5. ABSOLUTE WARRANTY EXCLUSIONS &amp; VOIDANCE CONDITIONS</h2>
<p>This manufacturer warranty is completely voided, and <b>FESTON</b> shall bear no liability for repair or replacement, if a system fault or failure arises directly or indirectly from:</p>
<ol class="alpha">
  <li>Omission, improper sizing, or bypass of external safety/protection hardware (ACDB, DCDB, SPD, DC MCCB, earthing infrastructure).</li>
  <li>Incorrect mechanical or electrical integration, reverse polarity connections, loose terminal torque, or improper field cable crimping.</li>
  <li>Unsanctioned access, opening of factory enclosures, physical field modifications, or repair attempts by unauthorized personnel.</li>
  <li>Environmental exposure including water ingress, high-pressure washing, localized flooding, heavy industrial dust deposits, severe oxidation, salinity/coastal corrosion, or internal pest/rodent infestation.</li>
  <li>Thermal abuse, operational exposure to continuous ambient heat exceeding 45°C, inadequate airflow ventilation, or direct sustained exposure to sunlight, rain, or standing water.</li>
  <li>Grid anomalies, massive power surges, direct or indirect lightning strikes, external electrical short-circuits, or fire.</li>
  <li>Integration with incompatible third-party batteries, uncertified inverters, or the deployment of unauthorized firmware variants.</li>
  <li>Improper warehouse storage without routine maintenance recharge protocols beyond 3 months, or leaving a system depleted below critical voltage thresholds for more than 24 hours.</li>
  <li>Transit physical shock, logistical damage, physical vandalism, or outright product theft.</li>
  <li>Relocation, resale, or transfer of the equipment outside the original installation address or outside the borders of India without prior express written clearance from Feston Corporate Office.</li>
</ol>

<h2>6. STANDARD CLAIMS ARCHITECTURE &amp; DIAGNOSTIC FLOW</h2>
<ol class="alpha">
  <li><b>Step 1: Ticket Logging:</b> Claims must be registered online through the FEST CRM portal <a href="https://festcare.vr2.in/">https://festcare.vr2.in/</a> or by emailing csm@festonsev.com within 7 days of the fault occurrence. Submissions require the original tax invoice, clear product serial numbers, active system fault codes, and a comprehensive set of photos/videos covering the complete installation layout.</li>
  <li><b>Step 2: Technical Triage:</b> <b>FESTON</b> technical support engineers will review data logs remotely via cloud connectivity or local extraction. A Return Merchandise Authorization (RMA) ticket number will be generated only if a defect falls within the covered parameters.</li>
  <li><b>Step 3: Component Allocation &amp; Resolution:</b> Following validation, replacement modules or service parts will be released to field partners. Field labor and on-site support operations are scheduled in coordination with authorized service centers.</li>
  <li><b>Step 4: Logistics Closure:</b> The customer or installer must return the decommissioned faulty components, clearly marked with the issued RMA number, to Feston's logistics depot within 14 days of receiving the resolution components. Final case closure is subject to full validation during forensic failure analysis.</li>
</ol>

<h2>7. SERVICE LOGISTICS &amp; TARGET RESPONSE FRAMEWORK</h2>
<p>Target operational schedules are guidelines for initial engineering engagement and diagnostic deployment. These timelines are calculated from the point an RMA is officially granted, excluding periods of force majeure, logistical disruptions, or customized parts sourcing delays.</p>

<table class="grid sla">
  <colgroup><col class="c1" /><col class="c2" /><col class="c3" /></colgroup>
  <thead><tr><th>Service Coverage Region</th><th>Target Field SLA</th><th>Delivery Scope &amp; Operational Caveats</th></tr></thead>
  <tbody>
${slaRows()}
  </tbody>
</table>

<h2>8. LIMITATION OF LIABILITY &amp; LEGAL MANDATE</h2>
<p><b>Limitation of Remedy:</b> Feston’s financial and operational liability is strictly restricted to the immediate repair or replacement of the physical component proven to be defective. Under no circumstances shall <b>FESTON</b>, its directors, or its affiliates be held liable for any incidental, indirect, special, punitive, or consequential damages, including but not limited to loss of power generation, lost commercial revenue, operational business interruption, alternative power generation utility costs, property damage, or bodily injury.</p>
<p><b>Non-Transferability:</b> This warranty is issued exclusively to the original commercial or residential buyer listed on the primary tax invoice. It is non-transferable to subsequent property owners or alternative installation sites unless formal permission is granted in writing by <b>FESTON</b>.</p>
<p><b>Product Evolution &amp; Lifecycle:</b> Discontinued or obsolete product lines will be settled using the closest equivalent technology available in active inventory or through balanced prorated financial reconciliation, at Feston’s final discretion.</p>
<p><b>Out-of-Warranty Billing:</b> Any engineering field visits, technical diagnostics, factory evaluations, structural components, or freight logistics associated with an excluded or out-of-warranty system fault will be fully invoiced to the customer according to standard corporate commercial rates.</p>

<div class="contact">Customer support no. : +91-93848 13428 &nbsp;|&nbsp; CRM Portal: <a href="https://festcare.vr2.in">https://festcare.vr2.in</a> &nbsp;|&nbsp; Email: csm@festonsev.com.</div>

</body></html>`;
}

/** "Page N of M", bottom right, in the same face as the document. */
function footerTemplate() {
    const b64 = fs.readFileSync(path.join(FONT_DIR, 'Exo2-Regular.ttf')).toString('base64');
    return `<style>@font-face{font-family:'Exo 2';src:url(data:font/ttf;base64,${b64}) format('truetype');}</style>
<div style="width:100%;padding:0 16mm 0 0;box-sizing:border-box;text-align:right;font-family:'Exo 2',sans-serif;font-size:8pt;color:#8A94A6;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
}

async function render() {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'] });
    try {
        const page = await browser.newPage();
        await page.setContent(html(), { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: footerTemplate(),
            margin: { top: '16mm', right: '16mm', bottom: '18mm', left: '16mm' },
        });
        return Buffer.from(pdf);
    } finally {
        await browser.close();
    }
}

function appModule(pdf) {
    return `// The ${PAGES}-page "Annexure to Warranty Certificate" (Feston standard warranty terms
// and performance conditions), appended to every warranty certificate PDF the
// app draws itself (2026-11-10). Same file the confirm service appends to the
// issued certificate: festonphase4-confirmurl/functions/lib/warranty-annexure.pdf,
// built there by scripts/build-warranty-annexure.js (Exo 2 throughout).
// Base64 like the other certificate assets, because Metro does not bundle .pdf.

export const WARRANTY_ANNEXURE_PDF_BASE64 =
  '${pdf.toString('base64')}';
`;
}

async function main() {
    const check = process.argv.includes('--check');
    const pdf = await render();
    const doc = await PDFDocument.load(pdf);
    const pages = doc.getPageCount();
    const fonts = new Set((pdf.toString('latin1').match(/\/BaseFont\s*\/[A-Za-z0-9+#_,\-]+/g) || []).map((s) => s.replace(/\/BaseFont\s*\//, '')));
    console.log(`rendered ${pages} page(s), ${(pdf.length / 1024).toFixed(0)} KB, fonts: ${[...fonts].join(', ')}`);
    if (check) {
        // Saved before the page check, so a wrong count can still be looked at.
        const out = path.join(require('os').tmpdir(), 'warranty-annexure-check.pdf');
        fs.writeFileSync(out, pdf);
        console.log(`--check: written to ${out}, repo files untouched`);
    }
    if (pages !== PAGES) throw new Error(`expected ${PAGES} pages, got ${pages} — adjust the stylesheet`);
    if (check) return;
    fs.writeFileSync(OUT_SERVICE, pdf);
    fs.writeFileSync(OUT_PORTAL, pdf);
    fs.writeFileSync(OUT_APP, appModule(pdf));
    for (const f of [OUT_SERVICE, OUT_PORTAL, OUT_APP]) console.log(`wrote ${path.relative(ROOT, f)}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
