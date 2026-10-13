'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { lookupCustomerForInstaller } = require('../lib/installer-lookup');

// A tiny Firestore fake: collections of {id -> data}, equality queries only.
function fakeFirestore(data) {
    const coll = (name) => ({
        doc: (id) => ({
            async get() {
                const d = (data[name] || {})[id];
                return { exists: d !== undefined, id, data: () => d };
            },
        }),
        where: (field, op, value) => ({
            limit: () => ({
                async get() {
                    const docs = Object.entries(data[name] || {})
                        .filter(([, d]) => d[field] === value)
                        .map(([id, d]) => ({ id, exists: true, data: () => d }));
                    return { empty: docs.length === 0, docs };
                },
            }),
        }),
    });
    return { collection: coll };
}

const verify = async (t) => {
    if (t === 'tok-app') return { uid: 'uid_app' };
    if (t === 'tok-portal') return { uid: 'uid_portal' };
    if (t === 'tok-customer') return { uid: 'uid_cust' };
    if (t === 'tok-inactive') return { uid: 'uid_off' };
    throw new Error('bad token');
};

const data = {
    installers: {
        uid_app: { name: 'App-provisioned', active: true },
        row_1: { name: 'Portal-provisioned', uid: 'uid_portal', active: true },
        row_2: { name: 'Let go', uid: 'uid_off', active: false },
    },
    users: {
        cust_1: { name: 'Raju Krishnan', email: 'raju@example.com', phone: '9043730533', city: 'Chennai', address: '12 Anna Salai' },
        cust_2: { name: 'Priya', email: 'priya@example.com', phone: '+919000000001' },
    },
};

const run = (authorization, phone) =>
    lookupCustomerForInstaller({ firestore: fakeFirestore(data), verifyIdToken: verify, authorization, phone });

test('no token -> 401', async () => {
    const r = await run(undefined, '9043730533');
    assert.equal(r.status, 401);
});

test('bad token -> 401, nothing revealed', async () => {
    const r = await run('Bearer nope', '9043730533');
    assert.equal(r.status, 401);
    assert.equal(r.body.customer, undefined);
});

test('a signed-in customer (not an installer) -> 403', async () => {
    const r = await run('Bearer tok-customer', '9043730533');
    assert.equal(r.status, 403);
});

test('a deactivated installer -> 403', async () => {
    const r = await run('Bearer tok-inactive', '9043730533');
    assert.equal(r.status, 403);
});

test('an app-provisioned installer finds a customer by bare phone', async () => {
    const r = await run('Bearer tok-app', '+91 90437 30533');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'found');
    assert.deepEqual(r.body.customer, {
        uid: 'cust_1', name: 'Raju Krishnan', email: 'raju@example.com',
        phone: '9043730533', city: 'Chennai', address: '12 Anna Salai',
    });
});

test('a portal-provisioned installer (row id ≠ uid) is accepted, and +91 storage matches', async () => {
    const r = await run('Bearer tok-portal', '9000000001');
    assert.equal(r.status, 200);
    assert.equal(r.body.customer.uid, 'cust_2');
});

test('unknown phone -> not-found, 200', async () => {
    const r = await run('Bearer tok-app', '9999999999');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'not-found');
});

test('too-short phone -> 400', async () => {
    const r = await run('Bearer tok-app', '123');
    assert.equal(r.status, 400);
});
