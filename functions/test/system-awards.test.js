'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { registeredPromptly, isFirstInstall, toMillis } = require('../lib/system-awards');

/** A Firestore-Timestamp-shaped stub, which is what `createdAt` actually is. */
const stamp = (iso) => ({ toDate: () => new Date(iso) });
const HOUR = 60 * 60 * 1000;

test('toMillis reads a bare date as UTC midnight', () => {
    // The install date carries no time, and midnight is the generous end of the
    // day — an install finished at 6pm still gets the whole 48 hours.
    assert.strictEqual(toMillis('2026-08-25'), Date.UTC(2026, 7, 25));
});

test('toMillis handles the shapes the record actually holds', () => {
    assert.strictEqual(toMillis(stamp('2026-08-25T10:00:00Z')), Date.parse('2026-08-25T10:00:00Z'));
    assert.strictEqual(toMillis(new Date('2026-08-25T10:00:00Z')), Date.parse('2026-08-25T10:00:00Z'));
    assert.strictEqual(toMillis(1756080000000), 1756080000000);
});

test('toMillis returns null rather than guessing', () => {
    for (const v of [null, undefined, '', '   ', 'not a date', {}]) {
        assert.strictEqual(toMillis(v), null, `expected null for ${JSON.stringify(v)}`);
    }
});

test('registered on the install day earns it', () => {
    assert.ok(registeredPromptly('2026-08-25', stamp('2026-08-25T18:00:00Z')));
});

test('registered 47 hours later earns it', () => {
    const at = new Date(Date.UTC(2026, 7, 25) + 47 * HOUR).toISOString();
    assert.ok(registeredPromptly('2026-08-25', stamp(at)));
});

test('exactly 48 hours earns it — the boundary is inclusive', () => {
    // A cut-off that excluded its own boundary would refuse a submission made
    // exactly on time, which is not what "within 48h" means to anyone.
    const at = new Date(Date.UTC(2026, 7, 25) + 48 * HOUR).toISOString();
    assert.ok(registeredPromptly('2026-08-25', stamp(at)));
});

test('a minute past 48 hours does not', () => {
    const at = new Date(Date.UTC(2026, 7, 25) + 48 * HOUR + 60000).toISOString();
    assert.ok(!registeredPromptly('2026-08-25', stamp(at)));
});

test('submitting before the install date still earns it', () => {
    // Dates are typed by hand and time zones move them. A date slightly in the
    // future is a typo, not an attempt to game a promptness bonus — and
    // refusing it would punish the installer for the data-entry quirk.
    assert.ok(registeredPromptly('2026-08-26', stamp('2026-08-25T09:00:00Z')));
});

test('a missing date is NOT earned', () => {
    // The rule cannot be judged, and the failure has to fall the safe way: a
    // record with no install date must not pay a promptness bonus by accident.
    assert.ok(!registeredPromptly('', stamp('2026-08-25T09:00:00Z')));
    assert.ok(!registeredPromptly('2026-08-25', null));
    assert.ok(!registeredPromptly(null, null));
});

test('isFirstInstall is true before any install is counted', () => {
    // Read BEFORE the transaction increments the counter, so zero or absent
    // means the one completing right now is their first.
    assert.ok(isFirstInstall({}));
    assert.ok(isFirstInstall({ lifetimeInstalls: 0 }));
    assert.ok(isFirstInstall(null));
    assert.ok(isFirstInstall({ lifetimeInstalls: 'not a number' }));
});

test('isFirstInstall is false once they have one', () => {
    assert.ok(!isFirstInstall({ lifetimeInstalls: 1 }));
    assert.ok(!isFirstInstall({ lifetimeInstalls: 40 }));
});
