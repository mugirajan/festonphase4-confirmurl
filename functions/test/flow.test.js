'use strict';

// OTP is Firebase Phone Auth, driven in a real browser — this in-process test
// can't run it, so these tests cover the core token->registration flow with OTP
// disabled. The two acknowledgements ARE sent below (required either way).
process.env.CONFIRM_OTP_ENABLED = 'false';

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
                // Resolve increment sentinels against what is already stored, so
                // a test can assert on the resulting NUMBER rather than on a
                // sentinel object. Without this the fake would silently store
                // `{__increment: 1}` where the real Firestore stores a count.
                const resolved = {};
                for (const [field, value] of Object.entries(data)) {
                    resolved[field] =
                        value && typeof value === 'object' && '__increment' in value
                            ? (Number(existing[field]) || 0) + value.__increment
                            : value;
                }
                documents.set(key(ref._collection, ref._id), { ...existing, ...resolved });
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
firestoreApi.FieldValue = {
    serverTimestamp: () => makeTimestamp(Date.now()),
    // Sentinel resolved by the fake `update` above. Absent until 2026-08-18,
    // which is why the installer-credit path went untested: `increment` was
    // undefined, and the only test that set `registeredByInstallerId` never
    // seeded an installer document, so the branch was never entered.
    increment: (n) => ({ __increment: n }),
};

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
const pressConfirm = (token) =>
    call({ method: 'POST', query: { t: token }, body: { acceptedTerms: true, acceptedDataForTraining: true } });

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

// --- installer credit ---------------------------------------------------------
//
// A completed registration is the only thing that moves an installer's lifetime
// install count, and the company's is the sum of its installers'. Both are read
// by the admin portal — the installers register, the company register and the
// badge tier derived from the company total — so getting them wrong is visible
// to Feston staff and to the installer being paid.
//
// Nothing incremented either field before 2026-08-18: the confirm transaction
// awarded points and stopped there, so every count in the portal was whatever
// had been seeded into it.

/** Seed an installer, their company, and the point value for a completion. */
function seedInstaller({ installs = 10, companyInstalls = 10, points = 50, active = true } = {}) {
    documents.set(key('installers', 'inst_55'), {
        name: 'Muthu Kumar',
        companyId: 'co_9',
        lifetimeInstalls: installs,
        points: 0,
        active,
    });
    documents.set(key('companies', 'co_9'), {
        name: 'Rppl Solar',
        lifetimeInstalls: companyInstalls,
    });
    if (points !== null) {
        documents.set(key('points_config', 'complete_registration'), { points, active: true });
    }
}

const installerDoc = () => documents.get(key('installers', 'inst_55'));
const companyDoc = () => documents.get(key('companies', 'co_9'));

test('confirming credits the installer and their company with one install', async () => {
    seedPending();
    seedInstaller({ installs: 10, companyInstalls: 10 });

    await pressConfirm(TOKEN);

    assert.equal(installerDoc().lifetimeInstalls, 11, "installer's lifetime count moves by one");
    assert.equal(companyDoc().lifetimeInstalls, 11, "company's rollup moves with it");
    assert.equal(installerDoc().points, 50, 'and the completion points are awarded');
});

test('confirming twice counts the install once', async () => {
    seedPending();
    seedInstaller({ installs: 10, companyInstalls: 10 });

    await pressConfirm(TOKEN);
    await pressConfirm(TOKEN);

    // The transaction returns early once the pending row is `completed`, so a
    // customer re-opening the link cannot inflate the count.
    assert.equal(installerDoc().lifetimeInstalls, 11, 'not 12');
    assert.equal(companyDoc().lifetimeInstalls, 11, 'not 12');
    assert.equal(installerDoc().points, 50, 'and the points are awarded once');
});

test('an install still counts when the points award is paused', async () => {
    seedPending();
    seedInstaller({ installs: 10, companyInstalls: 10, points: null });
    // No `points_config` document at all — nothing is payable.

    await pressConfirm(TOKEN);

    // The count records work done, not reward policy. Tying it to the award
    // would silently stop counting installs the moment a payout was paused.
    assert.equal(installerDoc().lifetimeInstalls, 11, 'the install is still counted');
    assert.equal(installerDoc().points, 0, 'but nothing is paid');
    assert.equal(registrations().length, 1, 'and the registration is created');
});

test('a deleted installer does not cost the customer their registration', async () => {
    seedPending();
    // `registeredByInstallerId` points at an installer that no longer exists —
    // deleted between the link being staged and the customer confirming.

    const res = await pressConfirm(TOKEN);

    assert.equal(res.body.status, 'completed');
    assert.equal(registrations().length, 1, 'the registration is the thing that matters');
    assert.equal(serialDoc().registered, true, 'and the serial is still flipped');
});

test('a deleted company does not stop the installer being credited', async () => {
    seedPending();
    seedInstaller({ installs: 10 });
    documents.delete(key('companies', 'co_9'));

    await pressConfirm(TOKEN);

    assert.equal(installerDoc().lifetimeInstalls, 11, 'the installer is still credited');
    assert.equal(registrations().length, 1, 'and the registration stands');
});
