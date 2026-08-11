'use strict';

/**
 * End-to-end flow test for the `confirm` function.
 *
 * Firebase is stubbed with an in-memory Firestore rather than mocked away, so
 * this exercises the real handler, the real routing and the real transaction
 * body in `store.js` — open the link, confirm it, and watch three documents
 * move together.
 *
 * The things worth breaking a build over are all asserted here: confirming
 * creates exactly one registration owned by the customer, the serial is flipped
 * in the same transaction, confirming twice registers once, an expired link
 * writes nothing and shows no personal data, and link machinery never leaks
 * onto the registration row.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// --- in-memory Firestore -----------------------------------------------------

const documents = new Map();
const key = (collection, id) => `${collection}/${id}`;

let autoIdCounter = 0;
const nextAutoId = () => `auto_${++autoIdCounter}`;

function makeTimestamp(millis) {
    return {
        toMillis: () => millis,
        toDate: () => new Date(millis),
        _millis: millis,
    };
}

function docRef(collection, id) {
    return {
        _collection: collection,
        _id: id,
        // Real DocumentReferences expose `id`; store.js reads it to report the
        // new registration's id back to the page.
        id,
        async get() {
            const data = documents.get(key(collection, id));
            return { exists: data !== undefined, data: () => data };
        },
        async set(data, options) {
            const existing = documents.get(key(collection, id));
            documents.set(
                key(collection, id),
                options && options.merge && existing ? { ...existing, ...data } : data,
            );
        },
    };
}

const firestoreApi = () => ({
    // `doc()` with no argument mints an auto-id, which is how the registration
    // document is created.
    collection: (name) => ({ doc: (id) => docRef(name, id === undefined ? nextAutoId() : id) }),
    async runTransaction(fn) {
        // Single-threaded fake: reads and writes apply immediately. Enough to
        // exercise the transaction body; concurrency itself is Firestore's job.
        const tx = {
            get: (ref) => ref.get(),
            update: (ref, data) => {
                const existing = documents.get(key(ref._collection, ref._id));
                if (existing === undefined) {
                    // Matches Firestore: update on a missing document throws.
                    throw new Error(`No document to update: ${key(ref._collection, ref._id)}`);
                }
                documents.set(key(ref._collection, ref._id), { ...existing, ...data });
            },
            set: (ref, data, options) => ref.set(data, options),
        };
        return fn(tx);
    },
});

firestoreApi.Timestamp = {
    fromMillis: (millis) => makeTimestamp(millis),
    now: () => makeTimestamp(Date.now()),
};
firestoreApi.FieldValue = { serverTimestamp: () => makeTimestamp(Date.now()) };

const fakeAdmin = {
    initializeApp() {},
    firestore: firestoreApi,
};

const logged = { errors: [], warnings: [] };
const fakeFunctions = {
    https: { onRequest: (handler) => handler },
    logger: {
        error(...args) {
            logged.errors.push(args);
        },
        warn(...args) {
            logged.warnings.push(args);
        },
        info() {},
    },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
    if (request === 'firebase-admin') return fakeAdmin;
    if (request === 'firebase-functions') return fakeFunctions;
    if (request === 'cors') return () => (req, res, next) => next();
    return originalLoad.call(this, request, ...rest);
};

const api = require('../index');

Module._load = originalLoad;

// --- request / response doubles ---------------------------------------------

function makeReq({ method = 'GET', path = '/', query = {}, body = {}, headers = {} } = {}) {
    return {
        method,
        path,
        query,
        body,
        get: (name) => headers[String(name).toLowerCase()],
    };
}

function makeRes() {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        set(name, value) {
            this.headers[name] = value;
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        send(payload) {
            this.body = payload;
            return this;
        },
    };
}

async function call(reqInit) {
    const res = makeRes();
    await api.confirm(makeReq(reqInit), res);
    return res;
}

const openPage = (token) => call({ method: 'GET', query: { t: token } });
const pressConfirm = (token) => call({ method: 'POST', query: { t: token } });

// --- fixtures ----------------------------------------------------------------

const TOKEN = 'pend1ngT0kenAAAAAAAAAAAAAAAAAAAA'; // 32 url-safe chars
const CUSTOMER_UID = 'uid_customer_001';
const SERIAL_DOC_ID = 'serial_doc_77';
const HOUR = 60 * 60 * 1000;

/** What the mobile app writes at review time. */
function seedPending(overrides = {}) {
    documents.clear();
    logged.errors.length = 0;
    logged.warnings.length = 0;
    autoIdCounter = 0;

    documents.set(key('serial_num', SERIAL_DOC_ID), {
        serialnumber: '2505063529',
        registered: false,
    });

    documents.set(key('pending_registrations', TOKEN), {
        // Link machinery — must never reach the registration row.
        token: TOKEN,
        status: 'pending',
        expiresAt: makeTimestamp(Date.now() + 48 * HOUR),
        createdAt: makeTimestamp(Date.now()),
        // Meta
        userId: CUSTOMER_UID,
        serialDocId: SERIAL_DOC_ID,
        registeredByInstallerId: 'inst_55',
        registeredByInstallerName: 'Muthu Kumar',
        registeredByInstallerPhone: '9876543210',
        // Payload
        serialnumber: '2505063529',
        productFamily: 'hybrid',
        inverterModel: 'FE-5.0-3P-HY',
        customerName: 'Raju Krishnan',
        customerPhone: '9043730533',
        customerEmail: 'raju.k@example.com',
        customerAddress: '12 Anna Salai',
        customerCity: 'Chennai',
        customerState: 'Tamil Nadu',
        installerName: 'Muthu Kumar',
        installationCompany: 'Rppl Solar',
        installationDate: '2026-05-30',
        warrantyEndDate: '2036-05-30',
        postalCode: '600032',
        ...overrides,
    });
}

const pendingDoc = () => documents.get(key('pending_registrations', TOKEN));
const serialDoc = () => documents.get(key('serial_num', SERIAL_DOC_ID));

function registrations() {
    return [...documents.entries()]
        .filter(([k]) => k.startsWith('registered_products/'))
        .map(([, value]) => value);
}

// --- the page ----------------------------------------------------------------

test('the link renders the review with a confirm button', async () => {
    seedPending();
    const res = await openPage(TOKEN);

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Raju Krishnan/);
    assert.match(res.body, /2505063529/);
    assert.match(res.body, /Confirm and complete registration/);
    // The countdown must read as hours at a 48-hour TTL, not "2880 minutes".
    assert.match(res.body, /\d+ hours/);
});

test('an unknown token shows nothing and reads no document', async () => {
    seedPending();
    const res = await openPage('n0SuchT0kenAAAAAAAAAAAAAAAAAAAAA');

    assert.equal(res.statusCode, 404);
    assert.doesNotMatch(res.body, /Raju Krishnan/);
});

test('a malformed token is rejected on shape alone', async () => {
    seedPending();
    const res = await openPage('../../etc/passwd');

    assert.equal(res.statusCode, 404);
    assert.doesNotMatch(res.body, /Raju Krishnan/);
});

test('an expired link shows no personal data', async () => {
    seedPending({ expiresAt: makeTimestamp(Date.now() - 1000) });
    const res = await openPage(TOKEN);

    assert.equal(res.statusCode, 410);
    assert.doesNotMatch(res.body, /Raju Krishnan/);
    assert.doesNotMatch(res.body, /2505063529/);
    assert.match(res.body, /expired/i);
});

// --- confirming ---------------------------------------------------------------

test('confirming registers the product to the customer and flips the serial', async () => {
    seedPending();
    const res = await pressConfirm(TOKEN);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'completed');
    assert.equal(res.body.alreadyCompleted, false);

    const rows = registrations();
    assert.equal(rows.length, 1, 'exactly one registration');

    const row = rows[0];
    assert.equal(row.userId, CUSTOMER_UID, 'owner is the customer, not the installer');
    assert.equal(row.serialnumber, '2505063529');
    assert.equal(row.customerName, 'Raju Krishnan');
    assert.equal(row.registeredByInstallerName, 'Muthu Kumar', 'installer recorded separately');

    assert.equal(serialDoc().registered, true, 'serial marked registered');

    const pending = pendingDoc();
    assert.equal(pending.status, 'completed');
    assert.equal(pending.registeredProductId, res.body.registeredProductId);
    assert.ok(pending.registeredProductId, 'the new registration id is recorded');
});

test('link machinery never lands on the registration row', async () => {
    seedPending();
    await pressConfirm(TOKEN);

    const row = registrations()[0];
    for (const field of ['token', 'status', 'expiresAt', 'serialDocId', 'registeredProductId']) {
        assert.equal(row[field], undefined, `${field} must not be copied onto the registration`);
    }
});

test('confirming twice registers once and returns the first id', async () => {
    seedPending();
    const first = await pressConfirm(TOKEN);
    const second = await pressConfirm(TOKEN);

    assert.equal(second.statusCode, 200);
    assert.equal(second.body.status, 'completed');
    assert.equal(second.body.alreadyCompleted, true);
    assert.equal(second.body.registeredProductId, first.body.registeredProductId);
    assert.equal(registrations().length, 1, 'still exactly one registration');
});

test('reopening the link after confirming shows the completed page', async () => {
    seedPending();
    await pressConfirm(TOKEN);
    const res = await openPage(TOKEN);

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Registration complete/);
    assert.doesNotMatch(res.body, /Confirm and complete registration/);
});

test('an expired link cannot be confirmed and writes nothing', async () => {
    seedPending({ expiresAt: makeTimestamp(Date.now() - 1000) });
    const res = await pressConfirm(TOKEN);

    assert.equal(res.statusCode, 410);
    assert.equal(res.body.status, 'expired');
    assert.equal(registrations().length, 0);
    assert.equal(serialDoc().registered, false, 'serial untouched');
    assert.equal(pendingDoc().status, 'pending');
});

test('a cancelled link cannot be confirmed', async () => {
    seedPending({ status: 'cancelled' });
    const res = await pressConfirm(TOKEN);

    assert.equal(res.statusCode, 409);
    assert.equal(registrations().length, 0);
    assert.equal(serialDoc().registered, false);
});

// --- failure modes worth being deliberate about -------------------------------

test('a record with no owner is refused rather than half-written', async () => {
    seedPending({ userId: '' });
    const res = await pressConfirm(TOKEN);

    assert.equal(res.statusCode, 422);
    assert.equal(registrations().length, 0, 'no ownerless registration');
    assert.equal(serialDoc().registered, false, 'serial not locked by a failed attempt');
    assert.equal(pendingDoc().status, 'pending', 'link stays usable once the record is fixed');
    assert.equal(logged.errors.length, 1, 'and it is logged for someone to act on');
});

test('a serial missing from inventory still registers the product', async () => {
    seedPending({ serialDocId: 'not_in_inventory' });
    const res = await pressConfirm(TOKEN);

    assert.equal(res.statusCode, 200);
    assert.equal(registrations().length, 1, 'the customer is not blocked by a bad serial ref');
    assert.equal(logged.warnings.length, 1, 'but it is flagged');
});

test('a record with no serialDocId still registers the product', async () => {
    seedPending({ serialDocId: '' });
    const res = await pressConfirm(TOKEN);

    assert.equal(res.statusCode, 200);
    assert.equal(registrations().length, 1);
    assert.equal(serialDoc().registered, false);
});
