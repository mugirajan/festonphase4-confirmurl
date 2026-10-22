'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { awardPhotoClaim, listPhotoRules, installPoints } = require('../lib/claim-award');

// A small Firestore fake: collections of {id -> data}, equality queries,
// and a transaction whose writes apply when the callback returns.
function fakeFirestore(seed) {
    const data = JSON.parse(JSON.stringify(seed));
    let auto = 0;
    const snapOf = (name, id, ref) => {
        const d = (data[name] || {})[id];
        return { exists: d !== undefined, id, ref, data: () => d, get: (f) => (d || {})[f] };
    };
    const docRef = (name, id) => {
        const ref = { _kind: 'doc', name, id };
        ref.get = async () => snapOf(name, id, ref);
        return ref;
    };
    const coll = (name) => ({
        doc: (id) => docRef(name, id || `auto_${++auto}`),
        where: (field, op, value) => ({
            limit: () => {
                const q = { _kind: 'query', name, field, value };
                q.get = async () => run(q);
                return q;
            },
        }),
    });
    const run = (q) => {
        const docs = Object.entries(data[q.name] || {})
            .filter(([, d]) => d[q.field] === q.value)
            .map(([id]) => snapOf(q.name, id, docRef(q.name, id)));
        return { empty: docs.length === 0, docs };
    };
    const put = (name, id, value) => {
        data[name] = data[name] || {};
        data[name][id] = value;
    };
    return {
        data,
        collection: coll,
        async runTransaction(fn) {
            const writes = [];
            const tx = {
                get: async (r) => (r._kind === 'query' ? run(r) : r.get()),
                set: (r, v, opt) => writes.push(() => put(r.name, r.id, opt && opt.merge ? { ...((data[r.name] || {})[r.id] || {}), ...v } : v)),
                update: (r, v) => writes.push(() => put(r.name, r.id, { ...(data[r.name] || {})[r.id], ...v })),
            };
            const out = await fn(tx);
            writes.forEach((w) => w());
            return out;
        },
    };
}

const verify = async (t) => {
    const map = { 'tok-sub': 'uid_sub', 'tok-helper': 'uid_help', 'tok-other': 'uid_other', 'tok-off': 'uid_off', 'tok-cust': 'uid_cust' };
    if (map[t]) return { uid: map[t] };
    throw new Error('bad token');
};

const seed = () => ({
    installers: {
        row_sub: { uid: 'uid_sub', name: 'Submitter', companyId: 'co1', companyName: 'Co One', active: true, points: 100 },
        uid_help: { uid: 'uid_help', name: 'Helper', companyId: 'co1', active: true, points: 0 },
        row_other: { uid: 'uid_other', name: 'Other company', companyId: 'co2', active: true, points: 0 },
        row_off: { uid: 'uid_off', name: 'Let go', companyId: 'co1', active: false, points: 0 },
    },
    registered_products: {
        reg1: { userId: 'cust1', customerName: 'Raju', serialnumber: 'SN1', registeredByInstallerId: 'uid_sub', installTeamUids: ['uid_sub', 'uid_help'], companyId: 'co1' },
        reg2: { userId: 'cust1', customerName: 'Raju', serialnumber: 'SN2', registeredByInstallerId: 'uid_sub', installTeamUids: ['uid_sub'], companyId: 'co1' },
    },
    points_config: {
        linkedin_post: { points: 50, active: true },
        wifi_logger: { points: 70, active: false },
        google_review: { points: 0, active: true },
        printed_certificate: { points: 200, active: true },
    },
});

// Each storage path has its own bytes, unless a test says otherwise.
const bytesFor = (overrides = {}) => async (p) => {
    if (overrides[p] === null) throw new Error('No such object');
    return Buffer.from(overrides[p] || `bytes-of-${p}`);
};

const call = (fs, token, body, files) =>
    awardPhotoClaim({
        firestore: fs,
        verifyIdToken: verify,
        authorization: token ? `Bearer ${token}` : undefined,
        body,
        readObject: bytesFor(files),
        now: () => 'NOW',
    });

const linkedin = (extra = {}) => ({ registrationId: 'reg1', kind: 'linkedin_post', storagePath: 'product_files/reg1/1.jpg', productFileId: 'pf1', ...extra });

test('no token -> 401 and nothing written', async () => {
    const fs = fakeFirestore(seed());
    const r = await call(fs, null, linkedin());
    assert.equal(r.status, 401);
    assert.equal(fs.data.installer_points, undefined);
});

test('the submitter uploads a LinkedIn photo -> paid at once, ledger + balance + approved claim', async () => {
    const fs = fakeFirestore(seed());
    const r = await call(fs, 'tok-sub', linkedin());
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'paid');
    assert.equal(r.body.points, 50);
    assert.equal(fs.data.installers.row_sub.points, 150);
    const ledger = Object.values(fs.data.installer_points);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].installerId, 'row_sub', 'keyed on the installers doc id');
    assert.equal(ledger[0].awardKey, 'linkedin_post:cust:cust1');
    const claim = Object.values(fs.data.points_claims)[0];
    assert.equal(claim.status, 'approved');
    assert.equal(claim.autoApproved, true);
    assert.equal(fs.data.product_files.pf1.awardedPoints, 50);
    assert.equal(Object.keys(fs.data.evidence_hashes).length, 1);
});

test('a team member (helper) on the install can earn it too', async () => {
    const fs = fakeFirestore(seed());
    const r = await call(fs, 'tok-helper', linkedin());
    assert.equal(r.body.status, 'paid');
    assert.equal(fs.data.installers.uid_help.points, 50);
});

test('an engineer not on the install -> 403', async () => {
    const fs = fakeFirestore(seed());
    const r = await call(fs, 'tok-other', linkedin());
    assert.equal(r.status, 403);
    assert.equal(r.body.status, 'not-on-install');
});

test('a deactivated engineer -> 403', async () => {
    const r = await call(fakeFirestore(seed()), 'tok-off', linkedin());
    assert.equal(r.status, 403);
});

test('a customer (not an installer) -> 403', async () => {
    const r = await call(fakeFirestore(seed()), 'tok-cust', linkedin());
    assert.equal(r.status, 403);
});

test('a per-customer rule pays once per customer, even across two installs', async () => {
    const fs = fakeFirestore(seed());
    await call(fs, 'tok-sub', linkedin());
    const again = await call(fs, 'tok-sub', linkedin({ registrationId: 'reg2', storagePath: 'product_files/reg2/2.jpg' }));
    assert.equal(again.body.status, 'already-paid');
    assert.equal(fs.data.installers.row_sub.points, 150, 'paid once');
});

test('a reviewed claim already filed the old way holds the award', async () => {
    const s = seed();
    s.points_claims = { old: { awardKey: 'linkedin_post:cust:cust1', status: 'pending' } };
    const fs = fakeFirestore(s);
    const r = await call(fs, 'tok-sub', linkedin());
    assert.equal(r.body.status, 'already-submitted', 'waiting on Feston, not "credited"');
    assert.equal(fs.data.installers.row_sub.points, 100);
});

test('an award already paid at confirm (ledger row, no claim) is not paid again on upload', async () => {
    const s = seed();
    s.points_config.wifi_logger.active = true;
    s.installer_points = { l1: { awardKey: 'wifi_logger:reg:reg1', action: 'wifi_logger', points: 70 } };
    const fs = fakeFirestore(s);
    const r = await call(fs, 'tok-sub', linkedin({ kind: 'wifi_logger' }));
    assert.equal(r.body.status, 'already-paid');
    assert.equal(fs.data.installers.row_sub.points, 100);
});

test('an approved old claim reads as already paid', async () => {
    const s = seed();
    s.points_claims = { old: { awardKey: 'linkedin_post:cust:cust1', status: 'approved' } };
    const r = await call(fakeFirestore(s), 'tok-sub', linkedin());
    assert.equal(r.body.status, 'already-paid');
});

test('a rejected old claim does not hold the award', async () => {
    const s = seed();
    s.points_claims = { old: { awardKey: 'linkedin_post:cust:cust1', status: 'rejected' } };
    const r = await call(fakeFirestore(s), 'tok-sub', linkedin());
    assert.equal(r.body.status, 'paid');
});

test('the same photo bytes reused on another award -> 409, nothing paid', async () => {
    const fs = fakeFirestore(seed());
    const same = { 'product_files/reg1/1.jpg': 'SAME', 'product_files/reg2/9.jpg': 'SAME' };
    await call(fs, 'tok-sub', linkedin(), same);
    const r = await call(fs, 'tok-sub', { registrationId: 'reg2', kind: 'printed_certificate', storagePath: 'product_files/reg2/9.jpg' }, same);
    assert.equal(r.status, 409);
    assert.equal(r.body.status, 'duplicate-photo');
    assert.equal(fs.data.company_points, undefined);
});

test('a photo already used as install evidence at confirm -> 409', async () => {
    const s = seed();
    const crypto = require('node:crypto');
    s.evidence_hashes = { [crypto.createHash('sha256').update('bytes-of-product_files/reg1/1.jpg').digest('hex')]: { registrationId: 'regX' } };
    const r = await call(fakeFirestore(s), 'tok-sub', linkedin());
    assert.equal(r.status, 409);
});

test('a paused rule -> nothing paid, says so', async () => {
    const fs = fakeFirestore(seed());
    const r = await call(fs, 'tok-sub', linkedin({ kind: 'wifi_logger' }));
    assert.equal(r.body.status, 'paused');
    assert.equal(fs.data.installers.row_sub.points, 100);
});

test('a rule worth 0 -> treated as paused', async () => {
    const r = await call(fakeFirestore(seed()), 'tok-sub', linkedin({ kind: 'google_review' }));
    assert.equal(r.body.status, 'paused');
});

test('a kind that earns nothing (installation photo) -> 400 not-rewarded', async () => {
    const r = await call(fakeFirestore(seed()), 'tok-sub', linkedin({ kind: 'installation' }));
    assert.equal(r.status, 400);
    assert.equal(r.body.status, 'not-rewarded');
});

test('a photo outside the install folder -> 400', async () => {
    const r = await call(fakeFirestore(seed()), 'tok-sub', linkedin({ storagePath: 'product_files/reg2/1.jpg' }));
    assert.equal(r.status, 400);
});

test('a photo that is not in Storage -> 404, nothing paid', async () => {
    const fs = fakeFirestore(seed());
    const r = await call(fs, 'tok-sub', linkedin(), { 'product_files/reg1/1.jpg': null });
    assert.equal(r.status, 404);
    assert.equal(fs.data.installers.row_sub.points, 100);
});

test('a company rule (printed certificate) credits the company, not the engineer', async () => {
    const fs = fakeFirestore(seed());
    const r = await call(fs, 'tok-sub', linkedin({ kind: 'printed_certificate' }));
    assert.equal(r.body.status, 'paid');
    assert.equal(r.body.paidTo, 'company');
    assert.equal(fs.data.installers.row_sub.points, 100);
    const row = Object.values(fs.data.company_points)[0];
    assert.equal(row.companyId, 'co1');
    assert.equal(row.points, 200);
});

test('claim-rules: an installer gets each kind with its live value; paused and zero read as inactive', async () => {
    const r = await listPhotoRules({ firestore: fakeFirestore(seed()), verifyIdToken: verify, authorization: 'Bearer tok-sub' });
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.body.rules.map((x) => [x.kind, x]));
    assert.deepEqual([by.linkedin_post.active, by.linkedin_post.points], [true, 50]);
    assert.equal(by.wifi_logger.active, false);
    assert.equal(by.google_review.active, false);
    assert.equal(by.facebook_post.active, false, 'no config row -> inactive');
});

test('claim-rules: a customer token -> 403', async () => {
    const r = await listPhotoRules({ firestore: fakeFirestore(seed()), verifyIdToken: verify, authorization: 'Bearer tok-cust' });
    assert.equal(r.status, 403);
});

test('unknown registration -> 404', async () => {
    const r = await call(fakeFirestore(seed()), 'tok-sub', { registrationId: 'nope', kind: 'linkedin_post', storagePath: 'product_files/nope/1.jpg' });
    assert.equal(r.status, 404);
});

// ── Install points summary (2026-10-22) ────────────────────────────────────

const summary = (fs, token, registrationId = 'reg1') =>
    installPoints({ firestore: fs, verifyIdToken: verify, authorization: `Bearer ${token}`, body: { registrationId } });

test('install points: what was earned on this install, and which photo rewards are still open', async () => {
    const s = seed();
    s.points_config.eb_bill_before_after = { points: 50, active: true };
    s.installer_points = {
        l1: { installerId: 'uid_sub', registrationId: 'reg1', action: 'complete_registration', points: 150, type: 'credit' },
        l2: { installerId: 'uid_help', registrationId: 'reg1', action: 'complete_registration', points: 30, type: 'credit' },
        // EB bill already paid for this CUSTOMER on another install.
        l3: { installerId: 'uid_sub', registrationId: 'reg2', action: 'eb_bill_before_after', points: 50, awardKey: 'eb_bill_before_after:cust:cust1' },
    };
    const r = await summary(fakeFirestore(s), 'tok-sub');
    assert.equal(r.status, 200);
    assert.equal(r.body.earnedTotal, 180, 'everything paid against reg1');
    assert.equal(r.body.myTotal, 150, "the caller's own share");
    assert.deepEqual(r.body.earned, [{ label: 'Install points', points: 180 }]);

    const byKind = Object.fromEntries(r.body.rules.map((x) => [x.kind, x.status]));
    assert.equal(byKind.linkedin_post, 'available');
    assert.equal(byKind.eb_bill_before_after, 'earned', 'once per customer: paid elsewhere counts');
    assert.equal(byKind.printed_certificate, 'available');
    assert.equal(byKind.wifi_logger, undefined, 'paused rules are left out');
    assert.equal(byKind.google_review, undefined, 'zero-point rules are left out');
    assert.equal(r.body.availableTotal, 50 + 200);
});

test('install points: only engineers who worked on the install may see it', async () => {
    const fs = fakeFirestore(seed());
    assert.equal((await summary(fs, 'tok-other')).status, 403);
    assert.equal((await summary(fs, 'tok-helper')).status, 200);
});
