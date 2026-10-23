'use strict';

// "Forgot your password?" — the reset link emailed by us (2026-10-23).

const test = require('node:test');
const assert = require('node:assert');
const { passwordReset, buildResetMailDocument } = require('../lib/password-reset');

function fakeFirestore(added) {
    return { collection: () => ({ add: async (doc) => { added.push(doc); return { id: 'mail-1' }; } }) };
}
const authWith = (users) => ({
    getUserByEmail: async (email) => {
        if (!users[email]) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
        return users[email];
    },
    generatePasswordResetLink: async (email) => `https://feston-test.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=abc&email=${email}`,
});
const logger = { warn() {}, error() {} };

test('a known login gets a branded email with the reset link, from Feston Care', async () => {
    const added = [];
    const out = await passwordReset({
        firestore: fakeFirestore(added),
        body: { email: 'Sowmiya@Example.com', installer: true },
        logger,
        auth: authWith({ 'sowmiya@example.com': { uid: 'u1', displayName: 'Soundarya R' } }),
        send: async () => ({ sent: true }),
    });
    assert.deepStrictEqual(out, { status: 200, body: { status: 'ok', sent: true } });
    assert.strictEqual(added.length, 1);
    const m = added[0];
    assert.deepStrictEqual(m.to, ['sowmiya@example.com']);
    assert.strictEqual(m.message.subject, 'Reset your Feston password');
    assert.match(m.message.text, /Hello Soundarya,/);
    assert.match(m.message.text, /installer account/);
    assert.match(m.message.text, /oobCode=abc/);
    assert.match(m.message.html, /#055CA7/);
    assert.match(m.message.html, /Choose a new password/);
    assert.strictEqual(m.passwordResetFor, 'u1');
});

test('an unknown address sends nothing and says sent: false', async () => {
    const added = [];
    const out = await passwordReset({ firestore: fakeFirestore(added), body: { email: 'nobody@example.com' }, logger, auth: authWith({}), send: async () => ({ sent: true }) });
    assert.deepStrictEqual(out, { status: 200, body: { status: 'ok', sent: false } });
    assert.strictEqual(added.length, 0);
});

test('a bad email is a 400; a send failure is a 503 so the app can fall back', async () => {
    const bad = await passwordReset({ firestore: fakeFirestore([]), body: { email: 'not-an-email' }, logger, auth: authWith({}) });
    assert.strictEqual(bad.status, 400);
    const down = await passwordReset({
        firestore: fakeFirestore([]), body: { email: 'a@b.co' }, logger,
        auth: authWith({ 'a@b.co': { uid: 'u2' } }), send: async () => ({ sent: false, reason: 'no-smtp' }),
    });
    assert.deepStrictEqual(down, { status: 503, body: { status: 'not-sent', reason: 'no-smtp' } });
});

test('the customer wording says "Feston account", not installer', () => {
    const doc = buildResetMailDocument({ to: 'c@x.io', name: '', link: 'https://x/y', installer: false });
    assert.match(doc.message.text, /Hello,\n/);
    assert.match(doc.message.text, /your Feston account \(c@x\.io\)/);
});
