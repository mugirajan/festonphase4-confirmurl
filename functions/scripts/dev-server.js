'use strict';

/**
 * Local dev server — the whole flow, in a browser, in one command.
 *
 *   npm run dev                 48-hour links, like production
 *   npm run dev -- --ttl 1      one-minute links, to watch the expiry work
 *
 * It runs the real `index.js` handler. The only thing swapped out is Firestore,
 * which is held in memory here, so nothing touches `feston-prod` and no
 * emulator, Java or network is involved. Restarting wipes everything.
 *
 * Opening `/` seeds a `pending_registrations` document exactly as the mobile
 * app would and redirects you to the customer's link. `/state` dumps every
 * document afterwards, so you can see the registration that was created and the
 * serial that was flipped.
 */

const http = require('node:http');
const Module = require('node:module');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(flag('port', 8080));
const TTL_MINUTES = Number(flag('ttl', String(48 * 60)));
const CONFIRM_PATH = '/app/register/confirm';

// Config is read at require time, so this must be set before index.js loads.
process.env.CONFIRM_PUBLIC_BASE_URL = `http://localhost:${PORT}${CONFIRM_PATH}`;

// --- in-memory Firestore -----------------------------------------------------

const documents = new Map();
const key = (collection, id) => `${collection}/${id}`;

let autoIdCounter = 0;
const nextAutoId = () => `auto_${++autoIdCounter}`;

const stamp = (millis) => ({
    toMillis: () => millis,
    toDate: () => new Date(millis),
});

function docRef(collection, id) {
    return {
        _collection: collection,
        _id: id,
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
    collection: (name) => ({ doc: (id) => docRef(name, id === undefined ? nextAutoId() : id) }),
    async runTransaction(fn) {
        return fn({
            get: (ref) => ref.get(),
            update: (ref, data) => {
                const existing = documents.get(key(ref._collection, ref._id));
                if (existing === undefined) {
                    throw new Error(`No document to update: ${key(ref._collection, ref._id)}`);
                }
                documents.set(key(ref._collection, ref._id), { ...existing, ...data });
            },
            set: (ref, data, options) => ref.set(data, options),
        });
    },
});
firestoreApi.Timestamp = { fromMillis: stamp, now: () => stamp(Date.now()) };
firestoreApi.FieldValue = { serverTimestamp: () => stamp(Date.now()) };

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
    if (request === 'firebase-admin') return { initializeApp() {}, firestore: firestoreApi };
    if (request === 'firebase-functions') {
        return {
            https: { onRequest: (handler) => handler },
            logger: { error: console.error, warn: console.warn, info: console.log },
        };
    }
    if (request === 'cors') return () => (req, res, next) => next();
    return originalLoad.call(this, request, ...rest);
};

const api = require('../index');
const { generateToken } = require('../lib/tokens');

Module._load = originalLoad;

// --- what the mobile app writes ----------------------------------------------

const CUSTOMER_UID = 'uid_customer_demo';
const SERIAL_DOC_ID = 'serial_sample_001';

/**
 * Seeds one pending registration and returns its link.
 *
 * This is the mobile app's half of the flow, and deliberately writes the
 * document directly rather than calling the service: under the new design the
 * app never calls us to mint a link, it writes the record and builds the URL
 * itself.
 */
function mintLink() {
    const token = generateToken();

    documents.set(key('serial_num', SERIAL_DOC_ID), {
        serialnumber: '2505063529',
        registered: false,
    });

    documents.set(key('pending_registrations', token), {
        token,
        status: 'pending',
        createdAt: stamp(Date.now()),
        expiresAt: stamp(Date.now() + TTL_MINUTES * 60 * 1000),

        userId: CUSTOMER_UID,
        serialDocId: SERIAL_DOC_ID,
        registeredByInstallerId: 'inst_demo_01',
        registeredByInstallerName: 'Muthu Kumar',
        registeredByInstallerPhone: '9876543210',

        serialnumber: '2505063529',
        productFamily: 'hybrid',
        inverterModel: 'FE-5.0-3P-HY',
        capacity: '5.0',
        Phase: '3',
        customerName: 'Raju Krishnan',
        customerPhone: '9043730533',
        customerEmail: 'raju.k@example.com',
        customerAddress: '12 Anna Salai, Guindy',
        customerCity: 'Chennai',
        customerState: 'Tamil Nadu',
        customerCountry: 'India',
        installerName: 'Muthu Kumar',
        installerContact: '9876543210',
        installationCompany: 'Rppl Solar Solutions',
        installationDate: '2026-05-30',
        installationAddress: '12 Anna Salai, Guindy',
        installationCity: 'Chennai',
        installationState: 'Tamil Nadu',
        installationCountry: 'India',
        postalCode: '600032',
        wifiLogger: 'WL-88213004',
        warrantyEndDate: '2036-05-30',
        batteryDetails: {
            purchased: true,
            brand: 'feston',
            festonBatteries: [
                { sn: '2401010001', model: 'FB-5.1' },
                { sn: '2401010002', model: 'FB-5.1' },
            ],
        },
    });

    return { token, url: `http://localhost:${PORT}${CONFIRM_PATH}?t=${token}` };
}

// --- request / response adapters --------------------------------------------

function readBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch {
                resolve({});
            }
        });
    });
}

function adaptRes(nodeRes) {
    return {
        statusCode: 200,
        _headers: {},
        set(name, value) {
            this._headers[name] = value;
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            nodeRes.writeHead(this.statusCode, { ...this._headers, 'Content-Type': 'application/json' });
            nodeRes.end(JSON.stringify(payload, null, 2));
            return this;
        },
        send(payload) {
            nodeRes.writeHead(this.statusCode, this._headers);
            nodeRes.end(payload);
            return this;
        },
    };
}

const adaptReq = (nodeReq, path, query, body) => ({
    method: nodeReq.method,
    path,
    query,
    body,
    get: (name) => nodeReq.headers[String(name).toLowerCase()],
});

/** Everything in the fake database, so the writes can be inspected. */
function dumpState() {
    const out = {};
    for (const [k, value] of documents.entries()) {
        out[k] = JSON.parse(
            JSON.stringify(value, (_key, v) =>
                v && typeof v.toMillis === 'function' ? new Date(v.toMillis()).toISOString() : v,
            ),
        );
    }
    return out;
}

// --- server ------------------------------------------------------------------

const server = http.createServer(async (nodeReq, nodeRes) => {
    const url = new URL(nodeReq.url, `http://localhost:${PORT}`);
    const query = Object.fromEntries(url.searchParams);
    const body = nodeReq.method === 'POST' ? await readBody(nodeReq) : {};

    // "/" seeds a fresh pending registration and sends you straight to its
    // link — the same thing the app does when the form is submitted.
    if (url.pathname === '/') {
        const link = mintLink();
        console.log(`  → new link (expires in ${TTL_MINUTES}m): ${link.url}`);
        nodeRes.writeHead(302, { Location: `${CONFIRM_PATH}?t=${link.token}` });
        return nodeRes.end();
    }

    if (url.pathname === '/state') {
        nodeRes.writeHead(200, { 'Content-Type': 'application/json' });
        return nodeRes.end(JSON.stringify(dumpState(), null, 2));
    }

    if (url.pathname === CONFIRM_PATH) {
        return api.confirm(adaptReq(nodeReq, CONFIRM_PATH, query, body), adaptRes(nodeRes));
    }

    nodeRes.writeHead(404, { 'Content-Type': 'text/plain' });
    nodeRes.end('Not found. Open http://localhost:' + PORT + '/');
});

server.listen(PORT, () => {
    const link = mintLink();
    console.log('');
    console.log('  Feston confirmation — local dev server');
    console.log('  ─────────────────────────────────────');
    console.log(`  Link lifetime : ${TTL_MINUTES} minute(s)`);
    console.log('  Storage       : in memory (feston-prod is not touched)');
    console.log('');
    console.log(`  Open this     : ${link.url}`);
    console.log(`  Fresh link    : http://localhost:${PORT}/`);
    console.log(`  Inspect writes: http://localhost:${PORT}/state`);
    console.log('');
    console.log('  Ctrl+C to stop.');
    console.log('');
});
