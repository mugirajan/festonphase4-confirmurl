'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    SPECIFIC_YIELD,
    GRID_FACTOR,
    TREES_PER_TONNE,
    capacityKw,
    totalCapacityKw,
    impactFor,
} = require('../lib/hero-impact');
const { formatNumber, issueYear } = require('../lib/hero-number');
const {
    TOKENS,
    escapeHtml,
    formatIssueDate,
    verifyLabelFor,
    dropRegion,
    renderHeroCertificateHtml,
} = require('../lib/hero-certificate');
const { firstName, subjectFor, textFor, buildMailDocument } = require('../lib/hero-mail');
const { identityFrom, millisOf, storagePath } = require('../lib/hero-issue');

/* -------------------------------------------------------------- impact -- */

test('the figures reproduce the approved artwork exactly', () => {
    // The mock-up shows a system offsetting 5 tonnes and "about 80 trees".
    // If this ever fails, the shipped certificate has stopped agreeing with the
    // design Feston signed off, which is the one thing this must not do.
    const five = impactFor(5);
    assert.equal(five.co2Tonnes, 5);
    assert.equal(five.trees, 80);
});

test('the constants are the cited ones, not drifted', () => {
    assert.equal(SPECIFIC_YIELD, 1450);
    assert.equal(GRID_FACTOR, 0.71);
    assert.equal(TREES_PER_TONNE, 16);
});

test('trees always follow tonnes at the artwork ratio', () => {
    for (const kw of [1, 2, 3, 7, 10, 25]) {
        const { co2Tonnes, trees } = impactFor(kw);
        assert.equal(trees, co2Tonnes * 16, `${kw} kW`);
    }
});

test('a sub-tonne system still reports a whole tonne, never zero', () => {
    // "offsets an estimated 0 tonnes" is both dispiriting and untrue.
    assert.equal(impactFor(0.4).co2Tonnes, 1);
    assert.equal(impactFor(0.05).co2Tonnes, 1);
});

test('no capacity yields no impact, so no certificate is issued', () => {
    assert.equal(impactFor(0).co2Tonnes, 0);
    assert.equal(impactFor(undefined).co2Tonnes, 0);
    assert.equal(impactFor('nonsense').co2Tonnes, 0);
});

test('capacity is read from every spelling the estate actually uses', () => {
    assert.equal(capacityKw(5), 5);
    assert.equal(capacityKw('5'), 5);
    assert.equal(capacityKw('5 kW'), 5);
    assert.equal(capacityKw('3 KW'), 3);
    assert.equal(capacityKw('4 KW '), 4);
    assert.equal(capacityKw('5.5kw'), 5.5);
});

test('capacity rejects rubbish rather than reading it as zero-ish', () => {
    assert.equal(capacityKw('kW5'), 0);
    assert.equal(capacityKw(''), 0);
    assert.equal(capacityKw(null), 0);
    assert.equal(capacityKw(-3), 0);
    assert.equal(capacityKw(NaN), 0);
});

test('capacity sums across a customer real registrations', () => {
    // Kamalraj Ganesan's three live rows on 2026-09-09: one written by the
    // un-fixed confirm function with NO capacity field at all, and two web rows
    // spelling it "3 KW" and "4 KW ". A missing field must not poison the sum.
    const rows = [{ capacity: undefined }, { capacity: '3 KW' }, { capacity: '4 KW ' }];
    assert.equal(totalCapacityKw(rows), 7);
    assert.equal(impactFor(totalCapacityKw(rows)).co2Tonnes, 7);
});

test('capacity falls back to the app older kilowatt spelling', () => {
    assert.equal(totalCapacityKw([{ kilowatt: 3 }, { capacity: '2' }]), 5);
});

test('summing avoids float dust', () => {
    // 1.1 + 2.2 is 3.3000000000000003 in binary floating point, and that would
    // be printed.
    assert.equal(totalCapacityKw([{ capacity: '1.1' }, { capacity: '2.2' }]), 3.3);
});

test('nulls and empty rows contribute nothing', () => {
    assert.equal(totalCapacityKw([null, undefined, {}, { capacity: '5' }]), 5);
    assert.equal(totalCapacityKw([]), 0);
});

/* ------------------------------------------------------------- numbers -- */

test('a certificate number matches the artwork shape', () => {
    assert.equal(formatNumber(2026, 41), 'FSV-SSH-2026-00041');
    assert.equal(formatNumber(2026, 1), 'FSV-SSH-2026-00001');
});

test('the sequence pads to five digits and does not truncate beyond', () => {
    assert.equal(formatNumber(2027, 12345), 'FSV-SSH-2027-12345');
    assert.equal(formatNumber(2027, 123456), 'FSV-SSH-2027-123456');
});

test('the issue year is India time, not the container clock', () => {
    // 19:00 UTC on 31 December is already 00:30 on 1 January in Kolkata.
    assert.equal(issueYear(new Date('2026-12-31T19:00:00Z')), 2027);
    assert.equal(issueYear(new Date('2026-12-31T17:00:00Z')), 2026);
});

/* --------------------------------------------------------- certificate -- */

test('the template declares exactly the tokens the renderer fills', () => {
    assert.deepEqual(
        [...TOKENS].sort(),
        [
            'certificate_number',
            'co2_tonnes',
            'customer_name',
            'issue_date',
            'qr_svg',
            'signatory_designation',
            'signatory_name',
            'trees',
            'verify_label',
        ],
    );
});

test('the issue date is printed in the artwork format, in India time', () => {
    assert.equal(formatIssueDate(new Date('2026-09-09T05:00:00Z')), '9 September 2026');
    // 20:30 UTC is already the next day in Kolkata.
    assert.equal(formatIssueDate(new Date('2026-09-09T20:30:00Z')), '10 September 2026');
});

test('the verify label drops the query string so the line cannot wrap', () => {
    // Keeping `?c=FSV-SSH-2026-00041` wrapped the label onto a second line and
    // squeezed the QR caption with it. The number is printed in full above.
    assert.equal(
        verifyLabelFor('https://festonsev.com/verify?c=FSV-SSH-2026-00041'),
        'festonsev.com/verify',
    );
    assert.equal(verifyLabelFor('https://www.festonsev.com/verify/'), 'festonsev.com/verify');
    assert.equal(verifyLabelFor(''), '');
});

test('a customer name cannot inject markup into their own certificate', () => {
    const html = render({ customerName: '<script>alert(1)</script>' });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
});

test('escapeHtml covers the five characters that matter', () => {
    assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('a full render leaves no unsubstituted token behind', () => {
    const html = render({});
    assert.equal(html.match(/\{\{\w+\}\}/g), null);
});

test('the page stays self-contained - no network, no third-party font', () => {
    // A document carrying a customer's name must render whole offline and must
    // not announce them to a font CDN. Same invariant as the confirm page.
    const html = render({});
    assert.ok(!/url\(https?:/i.test(html), 'remote url()');
    assert.ok(!/fonts\.g\w+\.com/i.test(html), 'google fonts host');
    assert.ok(!/<link\b/i.test(html), 'external <link>');
    assert.ok(!/<script\b/i.test(html), 'script tag');
});

test('an unsigned certificate drops the signature block, not prints a placeholder', () => {
    const html = render({ signatoryName: '', signatoryDesignation: '' });
    assert.ok(!html.includes('Signatory'));
    assert.ok(!html.includes('[Designation]'));
});

test('with no verify URL the QR and the verify line both go', () => {
    const html = render({ verifyUrl: '', qrSvg: '' });
    assert.ok(!html.includes('Verify at'));
    assert.ok(!html.includes('Scan to visit'));
    // The certificate number itself must survive - it is not part of the region.
    assert.ok(html.includes('FSV-SSH-2026-00041'));
});

test('a signed, verifiable certificate keeps both blocks', () => {
    const html = render({});
    assert.ok(html.includes('R. Kumar'));
    assert.ok(html.includes('Verify at'));
    assert.ok(html.includes('Scan to visit'));
});

test('the QR svg is injected as markup, everything else as text', () => {
    const html = render({ qrSvg: '<svg id="qr-under-test"></svg>' });
    assert.ok(html.includes('<svg id="qr-under-test">'));
});

test('dropRegion is a no-op for a region that is not there', () => {
    assert.equal(dropRegion('<p>hi</p>', 'nope'), '<p>hi</p>');
});

test('a missing token is refused rather than rendered blank', () => {
    assert.throws(
        () =>
            renderHeroCertificateHtml({
                customerName: 'A',
                issuedAt: new Date(),
                trees: 80,
                certificateNumber: 'FSV-SSH-2026-00041',
                verifyUrl: 'https://x.test/v',
                qrSvg: '<svg></svg>',
                signatoryName: 'S',
                signatoryDesignation: 'D',
                // co2Tonnes deliberately absent
            }),
        /missing token/,
    );
});

/* ---------------------------------------------------------------- mail -- */

test('the greeting uses a first name', () => {
    assert.equal(firstName('Kamalraj Ganesan '), 'Kamalraj');
    assert.equal(firstName('  '), '');
});

test('a reissue does not read like a duplicate of the first send', () => {
    const first = subjectFor({ customerName: 'Priya R', isReissue: false });
    const again = subjectFor({ customerName: 'Priya R', isReissue: true });
    assert.notEqual(first, again);
    assert.match(again, /updated/i);
});

test('the mail carries both files as attachments', () => {
    const doc = mail();
    assert.deepEqual(doc.to, ['k@example.test']);
    assert.equal(doc.message.attachments.length, 2);
    assert.deepEqual(
        doc.message.attachments.map((a) => a.filename),
        ['FSV-SSH-2026-00041.png', 'FSV-SSH-2026-00041.pdf'],
    );
});

test('attachments travel as URLs, never as inline bytes', () => {
    // A Firestore document is capped at 1 MiB and the PNG alone is ~830 KB.
    const doc = mail();
    for (const a of doc.message.attachments) {
        assert.ok(a.path.startsWith('https://'), 'attachment must be a URL');
        assert.equal(a.content, undefined);
    }
});

test('the mail states the figures the certificate states', () => {
    const doc = mail();
    assert.match(doc.message.html, /7 tonnes of CO/);
    assert.match(doc.message.html, /112 trees/);
    assert.match(doc.message.text, /7 tonnes of CO2/);
    assert.match(doc.message.text, /112 trees/);
});

test('a plain-text alternative always accompanies the html', () => {
    const doc = mail();
    assert.ok(doc.message.text.length > 0);
    assert.ok(!doc.message.text.includes('<'));
});

test('a mail with no recipient is refused rather than queued', () => {
    assert.throws(() => mail({ to: '' }), /recipient/);
});

test('a customer name cannot inject markup into the email either', () => {
    const doc = mail({ customerName: '<b>x</b> Ganesan' });
    assert.ok(!doc.message.html.includes('<b>x</b>'));
});

/* --------------------------------------------------------------- issue -- */

test('identity comes from the newest registration that actually has a name', () => {
    const who = identityFrom([
        { customerName: '   ' },
        { customerName: 'Kamalraj Ganesan ', customerEmail: ' k@example.test ' },
        { customerName: 'Older Name' },
    ]);
    assert.deepEqual(who, { name: 'Kamalraj Ganesan', email: 'k@example.test' });
});

test('no name anywhere means no identity, so no certificate', () => {
    assert.deepEqual(identityFrom([{}, { customerName: '' }]), { name: '', email: '' });
});

test('timestamps are read from every shape they arrive in', () => {
    assert.equal(millisOf({ toMillis: () => 1234 }), 1234);
    assert.equal(millisOf(new Date(5000)), 5000);
    assert.equal(millisOf('2026-09-09T00:00:00Z'), Date.parse('2026-09-09T00:00:00Z'));
    assert.equal(millisOf(null), 0);
    assert.equal(millisOf('not a date'), 0);
});

test('the storage path is stable and namespaced per customer', () => {
    assert.equal(
        storagePath('UID1', 'FSV-SSH-2026-00041', 'png'),
        'hero-certificates/UID1/FSV-SSH-2026-00041.png',
    );
});

/* --------------------------------------------------------------- utils -- */

function render(overrides) {
    return renderHeroCertificateHtml({
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
    });
}

function mail(overrides) {
    return buildMailDocument({
        to: 'k@example.test',
        customerName: 'Kamalraj Ganesan',
        certificateNumber: 'FSV-SSH-2026-00041',
        co2Tonnes: 7,
        trees: 112,
        pngUrl: 'https://storage.example.test/a.png?sig=1',
        pdfUrl: 'https://storage.example.test/a.pdf?sig=1',
        ...overrides,
    });
}
