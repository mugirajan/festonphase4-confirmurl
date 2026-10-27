'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    LAYOUTS,
    LAYOUT_NAMES,
    ASSETS,
    extractAssets,
    fillAssets,
    unsizeSvg,
    renderLayoutHtml,
} = require('../lib/hero-layouts');
const { renderHeroCertificateHtml } = require('../lib/hero-certificate');
const { storagePath, FILES } = require('../lib/hero-issue');
const { buildMailDocument } = require('../lib/hero-mail');
const { heroPageUrl } = require('../lib/config');

function values(overrides) {
    return {
        customerName: 'Kamalraj Ganesan',
        issuedAt: new Date('2026-09-09T05:00:00Z'),
        co2Tonnes: 7,
        trees: 112,
        certificateNumber: 'FSV-SSH-2026-00041',
        verifyUrl: 'https://festonsev.com/verify?c=FSV-SSH-2026-00041',
        qrSvg: '<svg id="qr"></svg>',
        signatoryName: 'R. Kumar',
        signatoryDesignation: 'Managing Director, Feston S.E.V Pvt. Ltd.',
        ...overrides,
    };
}

/* ------------------------------------------------------------- layouts -- */

test('three layouts: the artwork, a portrait and the 1080x1920 story', () => {
    assert.deepEqual(LAYOUT_NAMES, ['landscape', 'portrait', 'story']);
    assert.deepEqual(LAYOUTS.landscape, { width: 1123, height: 794, scale: 2, pdf: true });
    assert.deepEqual(LAYOUTS.portrait, { width: 794, height: 1123, scale: 2, pdf: true });
    assert.deepEqual(LAYOUTS.story, { width: 1080, height: 1920, scale: 1, pdf: false });
});

test('the brand assets come out of the designer file, all five of them', () => {
    assert.ok(ASSETS.fonts.split('@font-face').length - 1 === 5, 'five font faces');
    assert.ok(ASSETS.logo.startsWith('data:image/png;base64,'));
    assert.ok(ASSETS.emblem.startsWith('data:image/png;base64,'));
    assert.notEqual(ASSETS.logo, ASSETS.emblem);
    assert.ok(ASSETS.rose.startsWith('<svg') && ASSETS.rose.includes('id="rose"'));
    assert.ok(ASSETS.ribbon.startsWith('<svg') && ASSETS.ribbon.includes('OF RECOGNITION'));
});

test('a redesign that drops an asset fails at load, not on a customer', () => {
    assert.throws(() => extractAssets('<html><body>nothing here</body></html>'), /no longer carries/);
});

test('borrowed svgs lose their fixed size so CSS can place them', () => {
    assert.equal(unsizeSvg('<svg viewBox="0 0 1 1" width="10" height="20"><g/></svg>'), '<svg viewBox="0 0 1 1"><g/></svg>');
    assert.ok(!/<svg[^>]*\swidth=/.test(ASSETS.rose));
    assert.ok(!/<svg[^>]*\sheight=/.test(ASSETS.ribbon));
});

test('an unknown asset marker is refused rather than left in the page', () => {
    assert.throws(() => fillAssets('{{@nope}}'), /unknown asset marker/);
});

for (const layout of ['portrait', 'story']) {
    test(`${layout}: a full render leaves no token and no asset marker behind`, () => {
        const html = renderLayoutHtml(layout, values());
        assert.equal(html.match(/\{\{@?\w+\}\}/g), null);
        assert.ok(html.includes('Kamalraj Ganesan'));
        assert.ok(html.includes('FSV-SSH-2026-00041'));
        assert.ok(html.includes('9 September 2026'));
        assert.ok(html.includes('7 tonnes of CO'));
        assert.ok(html.includes('112 trees'));
    });

    test(`${layout}: stays self-contained - no network, no third-party font`, () => {
        const html = renderLayoutHtml(layout, values());
        assert.ok(!/url\(https?:/i.test(html), 'remote url()');
        assert.ok(!/fonts\.g\w+\.com/i.test(html), 'google fonts host');
        assert.ok(!/<link\b/i.test(html), 'external <link>');
        assert.ok(!/<script\b/i.test(html), 'script tag');
        assert.ok(html.includes("font-family: 'Exo 2'"), 'embedded Exo 2');
        assert.ok(html.includes(ASSETS.logo), 'embedded logo');
    });

    test(`${layout}: a customer name cannot inject markup`, () => {
        const html = renderLayoutHtml(layout, values({ customerName: '<script>alert(1)</script>' }));
        assert.ok(!html.includes('<script>alert(1)</script>'));
        assert.ok(html.includes('&lt;script&gt;'));
    });

    test(`${layout}: with no verify URL the QR and the verify line both go`, () => {
        const html = renderLayoutHtml(layout, values({ verifyUrl: '', qrSvg: '' }));
        assert.ok(!html.includes('Verify at'));
        assert.ok(!html.includes('Scan to visit'));
        assert.ok(html.includes('FSV-SSH-2026-00041'));
    });

    test(`${layout}: declares its own page size`, () => {
        const { width, height } = LAYOUTS[layout];
        const html = renderLayoutHtml(layout, values());
        assert.ok(html.includes(`width: ${width}px; height: ${height}px`));
    });
}

test('portrait: an unsigned certificate drops the signature block', () => {
    const html = renderLayoutHtml('portrait', values({ signatoryName: '', signatoryDesignation: '' }));
    assert.ok(!html.includes('Managing Director'));
    assert.ok(!html.includes('{{signatory_name}}'));
});

test('story: never carries a signature - it is a post, not the document', () => {
    const html = renderLayoutHtml('story', values());
    assert.ok(!html.includes('R. Kumar'));
    assert.ok(html.includes('#SolarSuperHero'));
});

test('landscape goes through the original renderer, byte for byte', () => {
    assert.equal(renderLayoutHtml('landscape', values()), renderHeroCertificateHtml(values()));
});

test('an unknown layout is refused', () => {
    assert.throws(() => renderLayoutHtml('square', values()), /unknown layout/);
});

/* -------------------------------------------------------------- storage -- */

test('landscape keeps its original object names; the others take a suffix', () => {
    assert.equal(storagePath('U', 'FSV-SSH-2026-00041', 'png'), 'hero-certificates/U/FSV-SSH-2026-00041.png');
    assert.equal(storagePath('U', 'FSV-SSH-2026-00041', 'pdf', 'landscape'), 'hero-certificates/U/FSV-SSH-2026-00041.pdf');
    assert.equal(storagePath('U', 'FSV-SSH-2026-00041', 'pdf', 'portrait'), 'hero-certificates/U/FSV-SSH-2026-00041-portrait.pdf');
    assert.equal(storagePath('U', 'FSV-SSH-2026-00041', 'png', 'story'), 'hero-certificates/U/FSV-SSH-2026-00041-story.png');
});

test('one issue stores five files under the fields the app and portal already read plus three new ones', () => {
    assert.deepEqual(
        FILES.map((f) => f.field),
        ['pngPath', 'pdfPath', 'portraitPngPath', 'portraitPdfPath', 'storyPngPath'],
    );
    assert.ok(FILES.every((f) => LAYOUT_NAMES.includes(f.layout)));
    assert.ok(!FILES.some((f) => f.layout === 'story' && f.ext === 'pdf'), 'no story pdf');
});

/* ----------------------------------------------------------------- mail -- */

test('the mail links to the certificate page when it has one, and still attaches two files', () => {
    const doc = buildMailDocument({
        to: 'k@example.test',
        customerName: 'Kamalraj Ganesan',
        certificateNumber: 'FSV-SSH-2026-00041',
        co2Tonnes: 7,
        trees: 112,
        pngUrl: 'https://x.test/a.png',
        pdfUrl: 'https://x.test/a.pdf',
        pageUrl: heroPageUrl('FSV-SSH-2026-00041'),
    });
    assert.equal(doc.message.attachments.filter((a) => !a.cid).length, 2);
    // The public page link was dropped from the mail on 2026-10-27: the files are attached, the app has the rest.
    assert.ok(!doc.message.html.includes('action=hero'));
    assert.ok(!doc.message.text.includes('action=hero'));
    assert.doesNotMatch(doc.message.html, /story-size/);
});

test('the page url is on the confirm function, so it exists wherever the confirm page does', () => {
    assert.equal(
        heroPageUrl('FSV-SSH-2026-00041'),
        'https://feston-prod.web.app/app/register/confirm?action=hero&n=FSV-SSH-2026-00041',
    );
});
