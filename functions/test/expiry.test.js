'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isExpired, secondsRemaining, toMillis, expiryFrom, TTL_MS } = require('../lib/expiry');

const NOW = Date.parse('2026-08-07T10:00:00.000Z');

test('a link one minute from its deadline is live', () => {
    assert.equal(isExpired(NOW + 60_000, NOW), false);
});

test('a link is expired the instant its deadline is reached', () => {
    assert.equal(isExpired(NOW, NOW), true);
});

test('a link one second past its deadline is expired', () => {
    assert.equal(isExpired(NOW - 1_000, NOW), true);
});

test('a missing deadline counts as expired', () => {
    // Fails closed: a record with no readable deadline must never be confirmable.
    assert.equal(isExpired(undefined, NOW), true);
    assert.equal(isExpired(null, NOW), true);
});

test('an unreadable deadline counts as expired', () => {
    assert.equal(isExpired('not a date', NOW), true);
    assert.equal(isExpired({}, NOW), true);
});

test('deadlines are read from Timestamp, Date, millis and ISO alike', () => {
    const iso = '2026-08-07T10:30:00.000Z';
    const millis = Date.parse(iso);
    assert.equal(toMillis({ toMillis: () => millis }), millis); // Firestore Timestamp
    assert.equal(toMillis(new Date(millis)), millis);
    assert.equal(toMillis(millis), millis);
    assert.equal(toMillis(iso), millis);
});

test('the default lifetime is 48 hours', () => {
    // Only the dev server and the docs use this. The deadline actually enforced
    // is always the `expiresAt` the app stored on the pending document.
    assert.equal(TTL_MS, 48 * 60 * 60 * 1000);
    assert.equal(expiryFrom(NOW), NOW + 48 * 60 * 60 * 1000);
});

test('remaining seconds floor at zero rather than going negative', () => {
    assert.equal(secondsRemaining(NOW + 90_000, NOW), 90);
    assert.equal(secondsRemaining(NOW - 90_000, NOW), 0);
    assert.equal(secondsRemaining(undefined, NOW), 0);
});
