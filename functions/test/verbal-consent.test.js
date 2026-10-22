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
    const res = await run(ctx, 'Bearer tok-crm', { token: 'T1', callbackId: 'cb1', outcome: 'consented', note: 'Customer confirmed all details over the phone', recordingRef: 'call-42', acceptedTerms: true, acceptedDataForTraining: true });
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
    const res = await run(ctx, 'Bearer tok-staff', { token: 'T-gone', callbackId: 'cb1', outcome: 'consented', note: 'said yes to everything', acceptedTerms: true, acceptedDataForTraining: true });
    assert.equal(res.status, 404);
    assert.equal(ctx.data.consent_callbacks.cb1.status, 'queued');
});

// ── The customer's own form on the call (2026-10-22) ───────────────────────

test('consent needs both required confirmations, as on the customer page', async () => {
    const ctx = setup();
    const base = { token: 'T1', outcome: 'consented', note: 'Customer confirmed everything' };
    assert.equal((await run(ctx, 'Bearer tok-staff', base)).status, 400);
    assert.equal((await run(ctx, 'Bearer tok-staff', { ...base, acceptedTerms: true })).status, 400);
    assert.equal(ctx.calls.length, 0, 'nothing registered without both');
    const ok = await run(ctx, 'Bearer tok-staff', { ...base, acceptedTerms: true, acceptedDataForTraining: true });
    assert.equal(ok.status, 200);
    // Declined and unreachable need no confirmations.
    assert.equal((await run(ctx, 'Bearer tok-staff', { token: 'T1', outcome: 'declined', note: 'Not interested' })).status, 200);
});

const { consentForm, CONFIRMATIONS } = require('../lib/consent-form');

test('the consent form gives staff the customer page sections and confirmations', async () => {
    const ctx = setup();
    const pending = {
        status: 'pending',
        expiresAt: { toMillis: () => Date.now() - 1000 },
        customerName: 'Yogesh',
        customerContact: '+919000000004',
        serialnumber: '2209040024',
        productFamily: 'ongrid',
        installationDate: '2026-10-22',
        installationAddress: '12, 2nd Avenue',
    };
    const loadPending = async (t) => (t === 'T1' ? pending : null);
    const call = (authorization, token) =>
        consentForm({ firestore: fakeFirestore(ctx.data), verifyIdToken: verify, authorization, body: { token }, loadPending });

    const r = await call('Bearer tok-crm', 'T1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sections.map((s) => s.title), ['Your details', 'Product', 'Installation']);
    assert.equal(r.body.expired, true, 'an expired link still opens for a consent call');
    assert.deepEqual(r.body.confirmations, CONFIRMATIONS);
    assert.deepEqual(CONFIRMATIONS.filter((c) => c.required).map((c) => c.key), ['acceptedTerms', 'acceptedDataForTraining']);

    assert.equal((await call('Bearer tok-company', 'T1')).status, 403, 'company admins do not take consent calls');
    assert.equal((await call('Bearer tok-crm', 'nope')).status, 404);
});
