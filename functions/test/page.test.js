'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { renderPendingPage, renderConfirmedPage, renderUnavailablePage } = require('../lib/page');
const { buildDetailsFromRegistration } = require('../lib/snapshot');

const DETAILS = buildDetailsFromRegistration({
    customerName: 'Raju',
    customerPhone: '9043730533',
    customerEmail: 'raju@example.com',
    customerAddress: '12 Anna Salai, Chennai',
    Serialnumber: '2505063529',
    productFamily: 'hybrid',
    modelnumber: 'FE-5.0-3P-HY',
    installationCompany: 'Rppl Solar',
    installationDate: '2026-05-30',
});

function pending(overrides = {}) {
    return renderPendingPage({
        details: DETAILS,
        expiresAt: Date.now() + 60 * 60 * 1000,
        actionUrl: 'https://example.test/app/register/confirm?t=TOKEN',
        token: 'TOKEN',
        logoUrl: '',
        ...overrides,
    });
}

test('the live page shows the details and the confirm button', () => {
    const html = pending();
    assert.ok(html.includes('Raju'));
    assert.ok(html.includes('2505063529'));
    assert.ok(html.includes('Hybrid Inverter'));
    assert.ok(html.includes('Confirm and complete registration'));
});

test('the live page states when the link expires', () => {
    assert.ok(pending().includes('This link expires in'));
});

test('a 48-hour link counts down in hours, not thousands of minutes', () => {
    const html = pending({ expiresAt: Date.now() + 48 * 60 * 60 * 1000 });
    assert.ok(/\d+ hours/.test(html));
    assert.ok(!/\d{3,} minutes/.test(html));
});

test('customer-supplied text cannot inject markup', () => {
    const html = renderPendingPage({
        details: buildDetailsFromRegistration({
            customerName: '<img src=x onerror=alert(1)>',
            customerEmail: '"><script>alert(2)</script>',
        }),
        expiresAt: Date.now() + 60_000,
        actionUrl: 'https://example.test/app/register/confirm?t=TOKEN',
        token: 'TOKEN',
    });

    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>alert(2)</script>'));
    assert.ok(html.includes('&lt;img src=x'));
});

test('an expired page carries no personal data', () => {
    const html = renderUnavailablePage({ reason: 'expired' });
    assert.ok(html.includes('This link has expired'));
    assert.ok(!html.includes('Raju'));
    assert.ok(!html.includes('2505063529'));
    assert.ok(!html.includes('Confirm and complete registration'));
});

test('an unknown-token page carries no personal data and is not framed as expiry', () => {
    const html = renderUnavailablePage({ reason: 'not-found' });
    assert.ok(html.includes('Link not found'));
    assert.ok(!html.includes('Raju'));
    assert.ok(!html.includes('Confirm and complete registration'));
});

test('reopening a completed link says so and offers no second confirm', () => {
    const html = renderConfirmedPage({ details: DETAILS });
    assert.ok(html.includes('Registration complete'));
    assert.ok(html.includes('Raju'));
    assert.ok(!html.includes('Confirm and complete registration'));
});

test('a cancelled link carries no personal data', () => {
    const html = renderUnavailablePage({ reason: 'cancelled' });
    assert.ok(html.includes('no longer active'));
    assert.ok(!html.includes('Raju'));
    assert.ok(!html.includes('Confirm and complete registration'));
});

/**
 * Two batteries used to render as one run-on list: the sub-heading rows carry no
 * label and no value, so the row template emitted an empty `<dt>`/`<dd>` pair,
 * dropping the heading text and consuming a cell of the two-column grid — which
 * put every pair after it in the wrong column.
 */
test('each of several batteries is headed and laid out on its own', () => {
    const html = pending({
        details: buildDetailsFromRegistration({
            customerName: 'Raju',
            Serialnumber: '2505063529',
            batteryDetails: {
                purchased: true,
                brand: 'feston',
                festonBatteries: [
                    { sn: '2401010001', model: 'FB-5', capacityKw: '5', subtype: 'Rack' },
                    { sn: '2401010002', model: 'FB-10', capacityKw: '10', subtype: 'Wall' },
                ],
            },
        }),
    });

    assert.ok(html.includes('<h3 class="subhead">Battery 1</h3>'));
    assert.ok(html.includes('<h3 class="subhead">Battery 2</h3>'));
    // Both batteries in full, each with the inverter's field treatment.
    for (const value of ['2401010001', 'FB-5', '5 kWh', '2401010002', 'FB-10', '10 kWh']) {
        assert.ok(html.includes(value), `missing ${value}`);
    }
    // A grid per battery, so one battery's fields cannot straddle the next's.
    assert.equal(html.split('<h3 class="subhead">').length - 1, 2);
    assert.ok(!/<dt><\/dt>/.test(html));
});

test('a lone battery is not numbered', () => {
    const html = pending({
        details: buildDetailsFromRegistration({
            customerName: 'Raju',
            batteryDetails: { purchased: true, brand: 'feston', festonBatteries: [{ sn: '2401010001', model: 'FB-5' }] },
        }),
    });

    assert.ok(html.includes('2401010001'));
    assert.ok(!html.includes('<h3 class="subhead">'));
});

test('every page asks not to be indexed', () => {
    for (const html of [pending(), renderConfirmedPage({ details: DETAILS }), renderUnavailablePage({ reason: 'expired' })]) {
        assert.ok(html.includes('name="robots" content="noindex, nofollow"'));
    }
});

test('the page is self-contained — no external scripts, styles or fonts', () => {
    const html = pending();
    assert.ok(!/<link[^>]+href=/i.test(html));
    assert.ok(!/<script[^>]+src=/i.test(html));
    // A subresource fetched from anywhere else is the thing this guards: the
    // page must render whole on a phone that has already lost its connection,
    // and must not announce a customer reading their own address to a third
    // party. `<a href>` is exempt — a link the customer may choose to follow is
    // not a request the page makes.
    assert.ok(!/url\(\s*['"]?https?:/i.test(html));
    assert.ok(!/fonts\.(googleapis|gstatic)\.com/i.test(html));
});

test('the embedded faces cover every weight the stylesheet asks for', () => {
    const html = pending();
    const declared = new Set(
        [...html.matchAll(/font-family:'([^']+)';font-style:normal;font-weight:(\d+)/g)].map(
            (m) => `${m[1]} ${m[2]}`,
        ),
    );

    // Exo 2 is --font-head, Inter is --font-body; nothing else in the page draws
    // a webfont. A rule asking for a weight with no face behind it gets a
    // browser-synthesised one, which is exactly the mismatch embedding is meant
    // to remove — so a new font-weight must come with a face in lib/fonts.js.
    assert.deepEqual([...declared].sort(), ['Exo 2 600', 'Inter 400', 'Inter 500']);
    for (const weight of html.matchAll(/font-family: var\(--font-head\);[^}]*?font-weight: (\d+)/g)) {
        assert.ok(declared.has(`Exo 2 ${weight[1]}`), `no Exo 2 ${weight[1]} face`);
    }
});
