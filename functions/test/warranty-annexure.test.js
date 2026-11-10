'use strict';

// The warranty annexure (lib/warranty-annexure.js): the shipped PDF loads,
// and appending it leaves the certificate page first with the three terms
// pages after it (Exo 2 build of 2026-11-10; the Arial original was four).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { appendWarrantyAnnexure, ANNEXURE_PATH } = require('../lib/warranty-annexure');

test('the annexure PDF ships with the service and has three pages', async () => {
    assert.ok(fs.existsSync(ANNEXURE_PATH), ANNEXURE_PATH);
    const doc = await PDFDocument.load(fs.readFileSync(ANNEXURE_PATH));
    assert.equal(doc.getPageCount(), 3);
});

test('appending puts the certificate page first and the three annexure pages after it', async () => {
    const cert = await PDFDocument.create();
    const page = cert.addPage([792, 612]);
    const font = await cert.embedFont(StandardFonts.Helvetica);
    page.drawText('WARRANTY CERTIFICATE', { x: 40, y: 560, size: 24, font });
    const certBytes = Buffer.from(await cert.save());

    const merged = await appendWarrantyAnnexure(certBytes);
    assert.ok(Buffer.isBuffer(merged));
    assert.equal(merged.subarray(0, 4).toString(), '%PDF');

    const doc = await PDFDocument.load(merged);
    assert.equal(doc.getPageCount(), 4);
    const first = doc.getPage(0).getSize();
    assert.equal(Math.round(first.width), 792, 'the landscape certificate page stays first');
    assert.equal(Math.round(first.height), 612);
    const second = doc.getPage(1).getSize();
    assert.ok(second.height > second.width, 'the annexure pages are portrait');
});
