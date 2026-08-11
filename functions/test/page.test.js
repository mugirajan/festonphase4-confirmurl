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

test('every page asks not to be indexed', () => {
    for (const html of [pending(), renderConfirmedPage({ details: DETAILS }), renderUnavailablePage({ reason: 'expired' })]) {
        assert.ok(html.includes('name="robots" content="noindex, nofollow"'));
    }
});

test('the page is self-contained — no external scripts, styles or fonts', () => {
    const html = pending();
    assert.ok(!/<link[^>]+href=/i.test(html));
    assert.ok(!/<script[^>]+src=/i.test(html));
});
