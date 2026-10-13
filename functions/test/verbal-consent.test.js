'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { recordVerbalConsent } = require('../lib/verbal-consent');

function fakeFirestore(data) {
    return {
        collection: (name) => ({
            doc: (id) => ({
                async get() {
                    const d = (data[name] || {})[id];
                    return { exists: d !== undefined, id, data: () => d };
                },
                async set(value, options) {
                    data[name] = data[name] || {};
                    data[name][id] = options && options.merge ? { ...(data[name][id] || {}), ...value } : value;
                },
            }),
        }),
    };
}

const verify = async (t) => {
    if (t === 'tok-staff') return { uid: 'u_staff' };
    if (t === 'tok-crm') return { uid: 'u_crm' };
    if (t === 'tok-company') return { uid: 'u_company' };
    if (t === 'tok-engineer') return { uid: 'u_eng' };
    throw new Error('bad token');
};

function setup() {
    const data = {
        admins: {
            u_staff: { name: 'Feston Admin', role: '' },
            u_crm: { name: 'Support', role: 'CRM' },
            u_company: { name: 'Nuera admin', role: 'company-admin' },
        },
        consent_callbacks: { cb1: { status: 'queued', token: 'T1' } },
    };
    const calls = [];
    const complete = async (token, opts) => {
        calls.push({ token, opts });
        if (token === 'T-gone') return { status: 'not-found' };
        return { status: 'completed', registeredProductId: 'reg_9', alreadyCompleted: false };
    };
    return { data, calls, complete };
}

const run = (ctx, authorization, body) =>
    recordVerbalConsent({
        firestore: fakeFirestore(ctx.data),
        verifyIdToken: verify,
        authorization,
        body,
        complete: ctx.complete,
        userAgent: 'test',
        now: () => new Date('2026-10-13T10:00:00Z'),
    });

test('no token, an engineer, or a company admin is refused', async () => {
    const ctx = setup();
    assert.equal((await run(ctx, '', { token: 'T1', outcome: 'consented', note: 'said yes' })).status, 403);
    assert.equal((await run(ctx, 'Bearer tok-engineer', { token: 'T1', outcome: 'consented', note: 'said yes' })).status, 403);
    assert.equal((await run(ctx, 'Bearer tok-company', { token: 'T1', outcome: 'consented', note: 'said yes' })).status, 403);
    assert.equal(ctx.calls.length, 0, 'nothing completed');
});

test('a bad outcome or a missing note is a 400', async () => {
    const ctx = setup();
    assert.equal((await run(ctx, 'Bearer tok-staff', { token: 'T1', outcome: 'maybe', note: 'x' })).status, 400);
    assert.equal((await run(ctx, 'Bearer tok-staff', { token: 'T1', outcome: 'consented', note: 'ok' })).status, 400);
    assert.equal((await run(ctx, 'Bearer tok-staff', { outcome: 'consented', note: 'said yes' })).status, 400);
});

test('consent recorded by staff completes the registration, ignoring link expiry, and closes the callback', async () => {
    const ctx = setup();
    const res = await run(ctx, 'Bearer tok-crm', { token: 'T1', callbackId: 'cb1', outcome: 'consented', note: 'Customer confirmed all details over the phone', recordingRef: 'call-42' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'completed');
    assert.equal(res.body.registeredProductId, 'reg_9');
    assert.equal(ctx.calls.length, 1);
    const { opts } = ctx.calls[0];
    assert.equal(opts.ignoreExpiry, true);
    assert.equal(opts.requirePhoneMatch, false);
    assert.equal(opts.acknowledgements.consentMethod, 'verbal');
    assert.equal(opts.acknowledgements.consentRecordedBy, 'u_crm');
    assert.equal(opts.acknowledgements.consentRecordedByName, 'Support');
    assert.equal(opts.acknowledgements.consentRecordingRef, 'call-42');
    assert.equal(opts.acknowledgements.acceptedTerms, true);
    const cb = ctx.data.consent_callbacks.cb1;
    assert.equal(cb.status, 'completed');
    assert.equal(cb.registeredProductId, 'reg_9');
    assert.equal(cb.calledByName, 'Support');
});

test('declined and unreachable close the callback without completing anything', async () => {
    const ctx = setup();
    let res = await run(ctx, 'Bearer tok-staff', { token: 'T1', callbackId: 'cb1', outcome: 'declined', note: 'Customer did not agree to the data clause' });
    assert.equal(res.status, 200);
    assert.equal(ctx.data.consent_callbacks.cb1.status, 'declined');
    res = await run(ctx, 'Bearer tok-staff', { token: 'T1', callbackId: 'cb1', outcome: 'unreachable' });
    assert.equal(res.status, 200);
    assert.equal(ctx.data.consent_callbacks.cb1.status, 'unreachable');
    assert.equal(ctx.calls.length, 0);
});

test('a link that no longer exists reports not-found and leaves the callback open', async () => {
    const ctx = setup();
    const res = await run(ctx, 'Bearer tok-staff', { token: 'T-gone', callbackId: 'cb1', outcome: 'consented', note: 'said yes to everything' });
    assert.equal(res.status, 404);
    assert.equal(ctx.data.consent_callbacks.cb1.status, 'queued');
});
