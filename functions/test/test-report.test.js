'use strict';

// The factory test report, rendered server-side for the certificate email (2026-10-23).

const test = require('node:test');
const assert = require('node:assert');
const { testReportFor, testReportHtml, phaseOf, testReportFilename } = require('../lib/test-report');

test('the three tables match the app: counts, headings and the phase-dependent voltage limits', () => {
    assert.strictEqual(testReportFor('ongrid', 'single').items.length, 25);
    assert.strictEqual(testReportFor('hybrid', 'three').items.length, 23);
    assert.strictEqual(testReportFor('batteries', 'single').items.length, 18);
    assert.deepStrictEqual(testReportFor('ongrid', 'single').headers, { item: 'Test item', spec: 'Specifications', result: 'Test Result' });
    const over = (f, p) => testReportFor(f, p).items.find((i) => i.item.startsWith('Over voltage')).spec;
    assert.strictEqual(over('ongrid', 'single'), '>280');
    assert.strictEqual(over('ongrid', 'three'), '>460');
    assert.strictEqual(over('hybrid', 'three'), '>460');
});

test('phase is read from the row in its stored shapes', () => {
    assert.strictEqual(phaseOf({ phase: 3 }), 'three');
    assert.strictEqual(phaseOf({ phase: '3' }), 'three');
    assert.strictEqual(phaseOf({ Phase: 'Three Phase' }), 'three');
    assert.strictEqual(phaseOf({ phase: 1 }), 'single');
    assert.strictEqual(phaseOf({}), 'single');
});

test('the page carries the serial, model, phase and every row; batteries show no phase', () => {
    const html = testReportHtml({ serialnumber: '2209040021', inverterModel: 'FE-2.0-1P-OG', productFamily: 'ongrid', phase: 1 });
    assert.match(html, /2209040021/);
    assert.match(html, /FE-2\.0-1P-OG/);
    assert.match(html, /Phase: Single Phase/);
    assert.strictEqual((html.match(/<tr class="(even|odd)">/g) || []).length, 25);
    assert.match(html, /Result: PASS/);
    const batt = testReportHtml({ serialnumber: 'TSTBATRACK000001', productFamily: 'batteries' });
    assert.doesNotMatch(batt, /Phase:/);
    assert.strictEqual(testReportFilename('2209040021'), 'Test-Report-2209040021.pdf');
});
