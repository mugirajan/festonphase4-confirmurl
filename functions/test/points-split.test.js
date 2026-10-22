'use strict';

// Multi-engineer installs: the company admin divides the held points, one
// Submit per engineer, and each credit leaves the engineer a notification.

const test = require('node:test');
const assert = require('node:assert');
const {
    splitTeam,
    listPendingSplits,
    listSplitHistory,
    awardSplit,
    listNotifications,
    markNotificationsRead,
} = require('../lib/points-split');

/** A small in-memory Firestore: docs, equality queries with limit, tx, batch. */
function fakeFirestore(seed = {}) {
    const docs = new Map(Object.entries(seed));
    let autoId = 0;
    const docRef = (col, id) => ({
        id,
        path: `${col}/${id}`,
        async get() {
            return snapOf(col, id);
        },
    });
    const snapOf = (col, id) => {
        const data = docs.get(`${col}/${id}`);
        return { id, exists: data !== undefined, data: () => data, ref: docRef(col, id) };
    };
    const query = (col, filters = [], max = Infinity) => ({
        where: (f, _op, v) => query(col, [...filters, [f, v]], max),
        limit: (n) => query(col, filters, n),
        async get() {
            const hits = [...docs.keys()]
                .filter((k) => k.startsWith(`${col}/`))
                .map((k) => snapOf(col, k.slice(col.length + 1)))
                .filter((s) => filters.every(([f, v]) => (s.data() || {})[f] === v))
                .slice(0, max);
            return { empty: hits.length === 0, docs: hits };
        },
    });
    const applyUpdate = (path, patch) => {
        const cur = { ...(docs.get(path) || {}) };
        for (const [k, v] of Object.entries(patch)) {
            if (v && v.__inc !== undefined) cur[k] = (Number(cur[k]) || 0) + v.__inc;
            else if (k.includes('.')) {
                const [a, b] = k.split('.');
                cur[a] = { ...(cur[a] || {}), [b]: v };
            } else cur[k] = v;
        }
        docs.set(path, cur);
    };
    const fs = {
        docs,
        collection: (col) => ({
            ...query(col),
            doc: (id) => docRef(col, id || `auto_${(autoId += 1)}`),
        }),
        async runTransaction(fn) {
            return fn({
                get: (refOrQuery) => refOrQuery.get(),
                set: (ref, data) => docs.set(ref.path, data),
                update: (ref, patch) => applyUpdate(ref.path, patch),
            });
        },
        batch() {
            const ops = [];
            return {
                update: (ref, patch) => ops.push([ref.path, patch]),
                commit: async () => ops.forEach(([p, patch]) => applyUpdate(p, patch)),
            };
        },
    };
    return fs;
}

const TOKENS = { 'tok-admin': 'admin_1', 'tok-other-admin': 'admin_2', 'tok-ravi': 'inst_12' };
const verifyIdToken = async (t) => {
    if (!TOKENS[t]) throw new Error('bad token');
    return { uid: TOKENS[t] };
};
const now = () => 'NOW';
const increment = (n) => ({ __inc: n });

function seed() {
    return fakeFirestore({
        'admins/admin_1': { role: 'company-admin', companyId: 'co_9', name: 'Priya (Rppl admin)' },
        'admins/admin_2': { role: 'company-admin', companyId: 'co_OTHER', name: 'Other admin' },
        'installers/inst_12': { name: 'Ravi', companyId: 'co_9', points: 10 },
        'installers/auto_x': { uid: 'inst_55', name: 'Muthu', companyId: 'co_9', points: 0 },
        'points_config/wifi_logger': { label: 'Wi-Fi logger', points: 75, active: true },
        'points_config/paused': { label: 'Paused rule', points: 40, active: false },
        'points_splits/reg_1': {
            registrationId: 'reg_1',
            companyId: 'co_9',
            status: 'pending',
            pool: 250,
            remaining: 250,
            team: [
                { uid: 'inst_12', name: 'Ravi', role: 'started' },
                { uid: 'inst_55', name: 'Muthu', role: 'completed' },
            ],
            awards: {},
            customer: { name: 'Malavika' },
            product: { serialnumber: '2209040029' },
        },
    });
}

const call = (fs, token, body) =>
    awardSplit({ firestore: fs, verifyIdToken, authorization: `Bearer ${token}`, body, now, increment });

test('splitTeam: two or more distinct engineers split; one does not', () => {
    assert.deepEqual(splitTeam({ installTeam: [{ uid: 'a' }] }), []);
    assert.deepEqual(splitTeam({ installTeam: [{ uid: 'a' }, { uid: 'a' }] }), [], 'the same engineer twice is one');
    assert.equal(splitTeam({ installTeam: [{ uid: 'a', role: 'started' }, { uid: 'b', role: 'completed' }] }).length, 2);
    assert.deepEqual(splitTeam({}), []);
});

test('the company admin sees only their own pending installs, with the active rules to pick from', async () => {
    const fs = seed();
    const mine = await listPendingSplits({ firestore: fs, verifyIdToken, authorization: 'Bearer tok-admin' });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.splits.map((s) => s.id), ['reg_1']);
    assert.deepEqual(mine.body.rules, [{ key: 'wifi_logger', label: 'Wi-Fi logger', points: 75 }]);

    const other = await listPendingSplits({ firestore: fs, verifyIdToken, authorization: 'Bearer tok-other-admin' });
    assert.deepEqual(other.body.splits, [], "another company's admin sees none of it");

    const engineer = await listPendingSplits({ firestore: fs, verifyIdToken, authorization: 'Bearer tok-ravi' });
    assert.equal(engineer.status, 403, 'an engineer is not a company admin');
});

test('each Submit credits one engineer, writes the ledger, and leaves them a notification', async () => {
    const fs = seed();
    const r = await call(fs, 'tok-admin', { registrationId: 'reg_1', installerUid: 'inst_12', points: 100 });
    assert.equal(r.status, 200);
    assert.equal(r.body.remaining, 150);
    assert.equal(fs.docs.get('installers/inst_12').points, 110);

    const ledger = [...fs.docs.values()].filter((d) => d.action === 'complete_registration');
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].points, 100);
    assert.equal(ledger[0].awardBasis, 'split');
    assert.equal(ledger[0].splitPhase, 'started');

    const note = [...fs.docs.values()].find((d) => d.kind === 'points-split');
    assert.equal(note.installerUid, 'inst_12');
    assert.equal(note.read, false);
    assert.match(note.message, /100 points for Malavika's install \(SN 2209040029\) — Started/);

    // The completer's row is keyed by an auto-id with a `uid` field.
    const r2 = await call(fs, 'tok-admin', { registrationId: 'reg_1', installerUid: 'inst_55', points: 150 });
    assert.equal(r2.body.done, true);
    assert.equal(fs.docs.get('installers/auto_x').points, 150);
    assert.equal(fs.docs.get('points_splits/reg_1').status, 'done');
});

test('an engineer already paid can be given more, but never past what is left', async () => {
    const fs = seed();
    // Everyone paid a little, with points still left: without top-ups this
    // install could never be finished.
    await call(fs, 'tok-admin', { registrationId: 'reg_1', installerUid: 'inst_12', points: 10 });
    await call(fs, 'tok-admin', { registrationId: 'reg_1', installerUid: 'inst_55', points: 10 });
    const more = await call(fs, 'tok-admin', { registrationId: 'reg_1', installerUid: 'inst_12', points: 100 });
    assert.equal(more.status, 200);
    assert.equal(more.body.remaining, 130);
    assert.equal(fs.docs.get('points_splits/reg_1').awards.inst_12.points, 110, 'running total for the install');
    assert.equal(fs.docs.get('installers/inst_12').points, 120);

    assert.equal((await call(fs, 'tok-admin', { registrationId: 'reg_1', installerUid: 'inst_55', points: 131 })).body.status, 'over');
    const last = await call(fs, 'tok-admin', { registrationId: 'reg_1', installerUid: 'inst_55', points: 130 });
    assert.equal(last.body.done, true);
    assert.equal(fs.docs.get('points_splits/reg_1').status, 'done');
});

test('refused: more than is left, bad amounts, someone not on the team, another company', async () => {
    const fs = seed();
    assert.equal((await call(fs, 'tok-admin', { registrationId: 'reg_1', installerUid: 'inst_12', points: 251 })).body.status, 'over');
    assert.equal((await call(fs, 'tok-admin', { registrationId: 'reg_1', installerUid: 'inst_12', points: 0 })).body.status, 'bad-points');
    assert.equal((await call(fs, 'tok-admin', { registrationId: 'reg_1', installerUid: 'inst_12', points: 2.5 })).body.status, 'bad-points');

    await call(fs, 'tok-admin', { registrationId: 'reg_1', installerUid: 'inst_12', points: 50 });
    assert.equal(
        (await call(fs, 'tok-admin', { registrationId: 'reg_1', installerUid: 'stranger', points: 10 })).body.status,
        'not-on-team',
    );
    assert.equal(
        (await call(fs, 'tok-other-admin', { registrationId: 'reg_1', installerUid: 'inst_55', points: 10 })).status,
        403,
    );
    assert.equal(fs.docs.get('installers/inst_12').points, 60, 'only the one valid credit landed');
});

test('history lists every share given, newest first, for the admin\'s own company only', async () => {
    const fs = seed();
    let t = 0;
    const stamp = () => ({ toMillis: () => (t += 1000) });
    const give = (installerUid, points) =>
        awardSplit({ firestore: fs, verifyIdToken, authorization: 'Bearer tok-admin', body: { registrationId: 'reg_1', installerUid, points }, now: stamp, increment });
    await give('inst_12', 100);
    await give('inst_55', 150);

    const h = await listSplitHistory({ firestore: fs, verifyIdToken, authorization: 'Bearer tok-admin' });
    assert.equal(h.status, 200);
    assert.deepEqual(
        h.body.rows.map((r) => [r.installerName, r.phase, r.points, r.customerName, r.serialnumber]),
        [
            ['Muthu', 'Completed', 150, 'Malavika', '2209040029'],
            ['Ravi', 'Started', 100, 'Malavika', '2209040029'],
        ],
    );
    assert.equal(h.body.rows[0].givenBy, 'Priya (Rppl admin)');

    const other = await listSplitHistory({ firestore: fs, verifyIdToken, authorization: 'Bearer tok-other-admin' });
    assert.deepEqual(other.body.rows, []);
});

test('an engineer lists their own notifications and marks them read', async () => {
    const fs = seed();
    await call(fs, 'tok-admin', { registrationId: 'reg_1', installerUid: 'inst_12', points: 100 });

    const list = await listNotifications({ firestore: fs, verifyIdToken, authorization: 'Bearer tok-ravi' });
    assert.equal(list.body.unread, 1);
    assert.equal(list.body.items[0].points, 100);

    const marked = await markNotificationsRead({ firestore: fs, verifyIdToken, authorization: 'Bearer tok-ravi', body: {} });
    assert.equal(marked.body.marked, 1);
    const after = await listNotifications({ firestore: fs, verifyIdToken, authorization: 'Bearer tok-ravi' });
    assert.equal(after.body.unread, 0);

    const none = await listNotifications({ firestore: fs, verifyIdToken, authorization: 'Bearer tok-admin' });
    assert.deepEqual(none.body.items, [], "nobody reads another engineer's notifications");
});
