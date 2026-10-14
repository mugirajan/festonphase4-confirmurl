'use strict';

/**
 * Local runner against the REAL feston-prod database — test points and the
 * Solar Super Hero certificate before anything is deployed.
 *
 *   npm run live                 OTP off: confirm with the two boxes only
 *   npm run live -- --otp        OTP on, with Firebase test numbers (code 123456)
 *   npm run live -- --port 8090
 *
 * What it does
 *   - Serves the real confirm handler (index.js) on
 *     http://localhost:8080/app/register/confirm. Open a customer link from the
 *     app with its host replaced by http://localhost:8080 and confirm it here:
 *     the registration is written to feston-prod, the engineer's points are
 *     credited, and the fraud checks run — exactly what the deployed function
 *     will do.
 *   - Watches registered_products for registrations created while it runs and
 *     issues the Hero certificate for each one, in place of the
 *     issueHeroCertificate trigger (a Firestore trigger only fires in the
 *     cloud). The certificate is rendered with the local Chrome, uploaded to
 *     the feston-prod bucket, and shows in the app and the portal.
 *
 * What it needs
 *   GOOGLE_APPLICATION_CREDENTIALS pointing at a feston-prod service-account key
 *   (Firebase console → Project settings → Service accounts → Generate new
 *   private key). Keep the key OUTSIDE this repo and delete it when testing is
 *   done: it can read and write everything.
 *
 * Safety
 *   - Nothing is deployed and nothing is read from functions/.env.
 *   - Hero email is OFF here (HERO_EMAIL_ENABLED=false), so a test never queues
 *     a mail that would go out to a real customer once SMTP is configured.
 *   - Only registrations created AFTER the runner starts get a certificate.
 */

const http = require('node:http');
const fs = require('node:fs');
const Module = require('node:module');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const PORT = Number(flag('port', 8080));
const CONFIRM_PATH = '/app/register/confirm';
const PROJECT_ID = 'feston-prod';
const BUCKET = 'feston-prod.firebasestorage.app';

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
if (!keyPath || !fs.existsSync(keyPath)) {
    console.error('');
    console.error('  GOOGLE_APPLICATION_CREDENTIALS is not set, or the file does not exist.');
    console.error('  Download a feston-prod service-account key (Firebase console → Project settings →');
    console.error('  Service accounts → Generate new private key), save it OUTSIDE the repo, then:');
    console.error('');
    console.error('    $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\\feston-keys\\feston-prod.json"');
    console.error('    npm run live');
    console.error('');
    process.exit(1);
}

// Config is read when index.js loads, so all of this comes first. Set here,
// never in functions/.env, which `firebase deploy` would ship to production.
process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT_ID, storageBucket: BUCKET });
process.env.CONFIRM_PUBLIC_BASE_URL = `http://localhost:${PORT}${CONFIRM_PATH}`;
process.env.CONFIRM_OTP_ENABLED = has('otp') ? 'true' : 'false';
process.env.CONFIRM_OTP_TEST_MODE = has('otp') ? 'true' : 'false';
process.env.HERO_EMAIL_ENABLED = 'false';

// firebase-functions and cors only wrap the handler; everything else is real.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
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
Module._load = originalLoad;

const admin = require('firebase-admin');
const heroFlow = require('../lib/hero-flow');
const { REGISTRATIONS_COLLECTION } = require('../lib/config');

// --- request / response adapters (same shape as scripts/dev-server.js) -------

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
    headers: nodeReq.headers,
    get: (name) => nodeReq.headers[String(name).toLowerCase()],
});

// --- server ------------------------------------------------------------------

const server = http.createServer(async (nodeReq, nodeRes) => {
    const url = new URL(nodeReq.url, `http://localhost:${PORT}`);
    const query = Object.fromEntries(url.searchParams.entries());

    if (nodeReq.method === 'OPTIONS') {
        nodeRes.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        });
        return nodeRes.end();
    }

    if (url.pathname === CONFIRM_PATH) {
        const body = nodeReq.method === 'POST' ? await readBody(nodeReq) : {};
        nodeRes.setHeader('Access-Control-Allow-Origin', '*');
        try {
            return await api.confirm(adaptReq(nodeReq, CONFIRM_PATH, query, body), adaptRes(nodeRes));
        } catch (error) {
            console.error('  confirm handler failed:', error);
            nodeRes.writeHead(500, { 'Content-Type': 'text/plain' });
            return nodeRes.end('Error — see the terminal.');
        }
    }

    nodeRes.writeHead(404, { 'Content-Type': 'text/plain' });
    nodeRes.end(`Not found. Open a customer link with its host replaced by http://localhost:${PORT}`);
});

// --- Hero certificate, in place of the cloud trigger -------------------------

const startedAt = admin.firestore.Timestamp.now();
const seen = new Set();

function watchRegistrations() {
    admin
        .firestore()
        .collection(REGISTRATIONS_COLLECTION)
        .where('createdAt', '>', startedAt)
        .onSnapshot(
            (snap) => {
                for (const change of snap.docChanges()) {
                    if (change.type !== 'added' || seen.has(change.doc.id)) continue;
                    seen.add(change.doc.id);
                    // Firestore orders a STRING after every Timestamp, so older
                    // rows whose createdAt was saved as text also match the
                    // query. Only a real Timestamp from after start counts —
                    // never issue a certificate for an old, real customer.
                    const created = change.doc.get('createdAt');
                    if (!(created instanceof admin.firestore.Timestamp) || created.toMillis() <= startedAt.toMillis()) continue;
                    void issueHero(change.doc.id, change.doc.data());
                }
            },
            (error) => console.error('  watching registrations failed:', error.message),
        );
}

async function issueHero(registrationId, data) {
    const uid = heroFlow.uidFromRegistration(data);
    const label = `${registrationId} (${data.Serialnumber || data.serialnumber || 'no serial'})`;
    if (!uid) {
        console.log(`  hero: ${label} has no customer account (userId), so no certificate — same as in the cloud.`);
        return;
    }
    console.log(`  hero: registration ${label} — issuing for customer ${uid}…`);
    try {
        const result = await heroFlow.issueForUser(uid, { logger: console });
        console.log('  hero: done', JSON.stringify(result));
    } catch (error) {
        console.error('  hero: failed', error);
    }
}

server.listen(PORT, () => {
    console.log('');
    console.log('  Feston confirm — LOCAL runner against feston-prod');
    console.log('  ────────────────────────────────────────────────');
    console.log(`  Confirm page : http://localhost:${PORT}${CONFIRM_PATH}?t=<token>`);
    console.log(`  OTP          : ${has('otp') ? 'ON (Firebase test numbers, code 123456)' : 'OFF (two boxes and Confirm)'}`);
    console.log('  Database     : feston-prod (REAL) — points, registrations, certificates are real rows');
    console.log('  Hero email   : off');
    console.log('');
    console.log('  Take a customer link from the app, replace');
    console.log('    https://feston-prod.web.app');
    console.log(`  with http://localhost:${PORT} and open it in this computer's browser.`);
    console.log('  Ctrl+C to stop.');
    console.log('');
    watchRegistrations();
});
