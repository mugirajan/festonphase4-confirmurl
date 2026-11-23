'use strict';

// A verified customer email is required before an engineer may submit an
// install (2026-11-23). The app asks `customer-email-status`.

const test = require('node:test');
const assert = require('node:assert');
const { customerEmailStatus, maskEmail } = require('../lib/customer-email');

function fakeFirestore(data) {
    const coll = (name) => ({
        doc: (id) => ({
            async get() {
                const d = (data[name] || {})[id];
                return { exists: d !== undefined, id, data: () => d, ref: { id } };
            },
            async set(v) {
                data[name] = { ...(data[name] || {}), [id]: v };
            },
        }),
        where: (field, _op, value) => ({
            limit: () => ({
                async get() {
                    const docs = Object.entries(data[name] || {})
                        .filter(([, d]) => d[field] === value)
                        .map(([id, d]) => ({ id, exists: true, data: () => d, ref: { id } }));
                    return { empty: docs.length === 0, docs };
                },
            }),
        }),
    });
    return { collection: coll, data };
}

const verify = async (t) => {
    if (t === 'tok-se') return { uid: 'uid_se' };
    if (t === 'tok-cust') return { uid: 'cust_ok' };
    throw new Error('bad token');
};

const users = {
    cust_ok: { email: 'ravi@gmail.com', emailVerified: true },
    cust_new: { email: 'meena.k@gmail.com', emailVerified: false },
    cust_blank: { email: '', emailVerified: false },
};

function setup({ withMail = true, at = 1_000_000 } = {}) {
    const fs = fakeFirestore({ installers: { uid_se: { name: 'Engineer', active: true } } });
    const sent = [];
    let now = at;
    const call = (token, body) =>
        customerEmailStatus({
            firestore: fs,
            verifyIdToken: verify,
            authorization: token ? `Bearer ${token}` : undefined,
            body,
            getUser: async (uid) => {
                if (!users[uid]) throw new Error('no user');
                return users[uid];
            },
            makeLink: async (email) => `https://verify.example/?e=${email}`,
            mail: () => (withMail ? { from: 'care@feston', transport: { sendMail: async (m) => sent.push(m) } } : null),
            clock: () => now,
        });
    return { fs, sent, call, tick: (ms) => (now += ms) };
}

test('customer email: only a signed-in engineer may ask', async () => {
    const { call } = setup();
    assert.equal((await call(null, { customerUid: 'cust_ok' })).status, 401);
    assert.equal((await call('tok-cust', { customerUid: 'cust_ok' })).status, 403);
    assert.equal((await call('tok-se', {})).status, 400);
    assert.equal((await call('tok-se', { customerUid: 'nobody' })).status, 404);
});

test('customer email: verified or not, with the address masked', async () => {
    const { call, sent } = setup();
    assert.deepEqual((await call('tok-se', { customerUid: 'cust_ok' })).body, { status: 'ok', verified: true, email: 'r***@gmail.com' });
    const no = await call('tok-se', { customerUid: 'cust_new' });
    assert.equal(no.body.verified, false);
    assert.equal(no.body.email, 'm******@gmail.com');
    assert.equal((await call('tok-se', { customerUid: 'cust_blank' })).body.verified, false);
    assert.equal(sent.length, 0, 'asking alone sends nothing');
});

test('customer email: resend mails the link, once a minute; never to a verified customer', async () => {
    const { call, sent, tick } = setup();
    const first = await call('tok-se', { customerUid: 'cust_new', resend: true });
    assert.equal(first.body.status, 'sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'meena.k@gmail.com');
    assert.match(sent[0].html, /verify\.example/);

    assert.equal((await call('tok-se', { customerUid: 'cust_new', resend: true })).status, 429);
    tick(61 * 1000);
    assert.equal((await call('tok-se', { customerUid: 'cust_new', resend: true })).body.status, 'sent');
    assert.equal(sent.length, 2);

    assert.equal((await call('tok-se', { customerUid: 'cust_ok', resend: true })).body.verified, true);
    assert.equal(sent.length, 2);
});

test('customer email: a server with no mail says so instead of pretending', async () => {
    const { call } = setup({ withMail: false });
    const r = await call('tok-se', { customerUid: 'cust_new', resend: true });
    assert.equal(r.status, 503);
    assert.equal(r.body.status, 'no-mail');
});

test('maskEmail', () => {
    assert.equal(maskEmail('ab@x.in'), 'a**@x.in');
    assert.equal(maskEmail('nonsense'), '');
});
