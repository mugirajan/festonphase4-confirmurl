'use strict';

/**
 * The "Annexure to Warranty Certificate" (2026-11-10): Feston's standard
 * manufacturer warranty terms and performance conditions, three pages
 * (lib/warranty-annexure.pdf). Feston supplied the text as a four-page Arial
 * PDF; scripts/build-warranty-annexure.js re-sets it in Exo 2 with even table
 * rows, and is the only thing that should write that file.
 *
 * Every warranty certificate PDF carries it after the certificate page, so
 * the customer's one file holds both the certificate and the terms it is
 * subject to. The PNG variant of the certificate is the page alone.
 *
 * The portal and the app append the same file to the certificates they draw
 * themselves (feston-care …/certificate/warranty-annexure.ts,
 * feston/src/assets/warrantyAnnexure.ts). Replace all three copies together.
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const ANNEXURE_PATH = path.join(__dirname, 'warranty-annexure.pdf');

let annexureBytes = null;
function annexurePdf() {
    if (!annexureBytes) annexureBytes = fs.readFileSync(ANNEXURE_PATH);
    return annexureBytes;
}

/** The certificate PDF with the annexure's pages appended. Returns a Buffer. */
async function appendWarrantyAnnexure(certificatePdf) {
    const doc = await PDFDocument.load(certificatePdf);
    const annexure = await PDFDocument.load(annexurePdf());
    const pages = await doc.copyPages(annexure, annexure.getPageIndices());
    for (const page of pages) doc.addPage(page);
    return Buffer.from(await doc.save({ useObjectStreams: false }));
}

module.exports = { appendWarrantyAnnexure, ANNEXURE_PATH };
