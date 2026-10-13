'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { normaliseNumber, findByNumber, fileFor, availableVariants, VARIANTS } = require('../lib/hero-serve');
const { renderHeroPage, fileHref } = require('../lib/hero-page');
const { renderUnavailablePage } = require('../lib/page');

function certificate(overrides) {
    return {
        uid: 'UID1',
        certificateNumber: 'FSV-SSH-2026-00041',
        customerName: 'Kamalraj Ganesan',
        customerEmail: 'k@example.test',
        co2Tonnes: 7,
        trees: 112,
        status: 'ready',
        version: 2,
        issuedAt: new Date('2026-09-09T05:00:00Z'),
        pngPath: 'hero-certificates/UID1/FSV-SSH-2026-00041.png',
        pdfPath: 'hero-certificates/UID1/FSV-SSH-2026-00041.pdf',
        portraitPngPath: 'hero-certificates/UID1/FSV-SSH-2026-00041-portrait.png',
        portraitPdfPath: 'hero-certificates/UID1/FSV-SSH-2026-00041-portrait.pdf',
        storyPngPath: 'hero-certificates/UID1/FSV-SSH-2026-00041-story.png',
        ...overrides,
    };
}

/* ---------------------------------------------------------------- serve -- */

test('a certificate number is accepted in any case, with whitespace, and nothing else', () => {
    assert.equal(normaliseNumber(' fsv-ssh-2026-00041 '), 'FSV-SSH-2026-00041');
    assert.equal(normaliseNumber('FSV-SSH-2026-123456'), 'FSV-SSH-2026-123456');
    assert.equal(normaliseNumber('FSV-SSH-2026-0041'), '');
    assert.equal(normaliseNumber('UID1'), '');
    assert.equal(normaliseNumber(''), '');
    assert.equal(normaliseNumber(null), '');
});

test('lookup is by the certificateNumber field, limited to one, and refuses junk before touching Firestore', async () => {
    const calls = [];
    const firestore = {
        collection: (name) => ({
            where: (field, op, value) => ({
                limit: (n) => ({
                    get: async () => {
                        calls.push({ name, field, op, value, n });
                        return { empty: false, docs: [{ id: 'UID1', data: () => ({ certificateNumber: value }) }] };
                    },
                }),
            }),
        }),
    };
    const found = await findByNumber(firestore, 'fsv-ssh-2026-00041');
    assert.deepEqual(found, { uid: 'UID1', certificateNumber: 'FSV-SSH-2026-00041' });
    assert.deepEqual(calls, [{ name: 'hero_certificates', field: 'certificateNumber', op: '==', value: 'FSV-SSH-2026-00041', n: 1 }]);

    assert.equal(await findByNumber(firestore, 'not-a-number'), null);
    assert.equal(calls.length, 1, 'no read for an invalid number');
});

test('each variant maps to its stored path, content type and a named download', () => {
    const c = certificate();
    assert.deepEqual(fileFor(c, 'story'), {
        path: c.storyPngPath,
        contentType: 'image/png',
        filename: 'FSV-SSH-2026-00041-story.png',
    });
    assert.deepEqual(fileFor(c, 'PORTRAIT-PDF'), {
        path: c.portraitPdfPath,
        contentType: 'application/pdf',
        filename: 'FSV-SSH-2026-00041-portrait.pdf',
    });
    assert.equal(fileFor(c, 'pdf').filename, 'FSV-SSH-2026-00041.pdf');
});

test('an unknown variant, or one this certificate never rendered, is null', () => {
    assert.equal(fileFor(certificate(), 'gif'), null);
    assert.equal(fileFor(certificate({ storyPngPath: undefined }), 'story'), null);
    assert.equal(fileFor(null, 'png'), null);
});

test('an older certificate with only the landscape pair offers only those', () => {
    const old = certificate({ portraitPngPath: '', portraitPdfPath: '', storyPngPath: '' });
    assert.deepEqual(availableVariants(old).map((v) => v.variant), ['png', 'pdf']);
    assert.deepEqual(availableVariants(certificate()).map((v) => v.variant), Object.keys(VARIANTS));
});

/* ----------------------------------------------------------------- page -- */

test('the page shows the certificate, its facts, and a download for every file', () => {
    const html = renderHeroPage({ certificate: certificate(), logoUrl: '' });
    assert.ok(html.includes('Kamalraj Ganesan'));
    assert.ok(html.includes('FSV-SSH-2026-00041'));
    assert.ok(html.includes('9 September 2026'));
    assert.ok(html.includes('7 tonnes of CO'));
    assert.ok(html.includes('112 trees'));
    assert.ok(html.includes('src="?action=hero-file&amp;n=FSV-SSH-2026-00041&amp;f=png"'));
    for (const variant of Object.keys(VARIANTS)) {
        assert.ok(html.includes(`f=${variant}&amp;dl=1`), `download link for ${variant}`);
    }
});

test('the page never prints the customer email or uid', () => {
    const html = renderHeroPage({ certificate: certificate(), logoUrl: '' });
    assert.ok(!html.includes('k@example.test'));
    assert.ok(!html.includes('UID1'));
});

test('a certificate still rendering shows its facts and no broken image', () => {
    const html = renderHeroPage({ certificate: certificate({ status: 'rendering' }), logoUrl: '' });
    assert.ok(html.includes('Being prepared'));
    assert.ok(!html.includes('<img src="?action=hero-file'));
    assert.ok(!html.includes('dl=1'));
    assert.ok(html.includes('7 tonnes of CO'));
});

test('a customer name cannot inject markup into the page', () => {
    const html = renderHeroPage({ certificate: certificate({ customerName: '<b>x</b>' }), logoUrl: '' });
    assert.ok(!html.includes('<b>x</b>'));
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
});

test('issuedAt is read as a Firestore Timestamp or a Date', () => {
    const ts = { toDate: () => new Date('2026-09-09T05:00:00Z') };
    assert.ok(renderHeroPage({ certificate: certificate({ issuedAt: ts }), logoUrl: '' }).includes('9 September 2026'));
    assert.ok(!renderHeroPage({ certificate: certificate({ issuedAt: null }), logoUrl: '' }).includes('Issued on'));
});

test('file links are relative to the page, so they work behind any host or rewrite', () => {
    assert.equal(fileHref('FSV-SSH-2026-00041', 'story', true), '?action=hero-file&n=FSV-SSH-2026-00041&f=story&dl=1');
    assert.equal(fileHref('FSV-SSH-2026-00041', 'png', false), '?action=hero-file&n=FSV-SSH-2026-00041&f=png');
});

test('an unknown number gets a certificate-specific not-found page', () => {
    const html = renderUnavailablePage({ reason: 'no-certificate', logoUrl: '' });
    assert.ok(html.includes('Certificate not found'));
    assert.ok(!html.includes('confirmation link'));
});
