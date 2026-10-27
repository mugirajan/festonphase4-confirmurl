'use strict';

// Staff-only list/update of company submissions through the service (2026-10-27).

const test = require('node:test');
const assert = require('node:assert');
const { companySubmissionAction } = require('../lib/company-submission-admin');

function fakeFirestore({ admins = {}, submissions = {} } = {}) {
    const writes = [];
    const doc = (col, id) => ({
        get: async () => {
            const data = col === 'admins' ? admins[id] : submissions[id];
            return { exists: !!data, id, data: () => data };
        },
        update: async (fields) => { writes.push({ id, fields }); },
    });
    return {
        writes,
        collection: (col) => ({
            doc: (id) => doc(col, id),
            limit: () => ({ get: async () => ({ docs: Object.entries(submissions).map(([id, data]) => ({ id, data: () => data })) }) }),
        }),
    };
}

const verify = async (t) => ({ uid: t });
const now = () => new Date('2026-10-27T10:00:00Z');

test('a customer or a company admin may not list submissions', async () => {
    const fs = fakeFirestore({ admins: { ca: { role: 'company-admin', companyId: 'c1' } } });
    assert.equal((await companySubmissionAction({ firestore: fs, verifyIdToken: verify, authorization: 'Bearer cust', op: 'list' })).status, 403);
    assert.equal((await companySubmissionAction({ firestore: fs, verifyIdToken: verify, authorization: 'Bearer ca', op: 'list' })).status, 403);
    assert.equal((await companySubmissionAction({ firestore: fs, verifyIdToken: verify, authorization: '', op: 'list' })).status, 401);
});

test('staff list every submission with timestamps as ISO strings', async () => {
    const fs = fakeFirestore({
        admins: { staff: { role: 'admin' } },
        submissions: { 'kamalsolars__98': { name: 'Kamal solars', status: 'pending', createdAt: { toDate: () => new Date('2026-10-27T12:39:29Z') } } },
    });
    const r = await companySubmissionAction({ firestore: fs, verifyIdToken: verify, authorization: 'Bearer staff', op: 'list' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, [{ id: 'kamalsolars__98', name: 'Kamal solars', status: 'pending', createdAt: '2026-10-27T12:39:29.000Z' }]);
});

test('staff update only the allowed fields, with the reviewer and time stamped', async () => {
    const fs = fakeFirestore({ admins: { staff: { role: 'admin' } }, submissions: { s1: { status: 'pending' } } });
    const r = await companySubmissionAction({
        firestore: fs, verifyIdToken: verify, authorization: 'Bearer staff', op: 'update', submissionId: 's1', now,
        patch: { status: 'approved', companyId: 'co_1', reviewedByName: 'QA Feston Admin', name: 'hacked', registrationIds: [] },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(fs.writes, [{ id: 's1', fields: { status: 'approved', companyId: 'co_1', reviewedByName: 'QA Feston Admin', reviewedBy: 'staff', reviewedAt: now(), updatedAt: now() } }]);
});

test('a bad status, an unknown submission and an empty patch are refused', async () => {
    const fs = fakeFirestore({ admins: { staff: { role: 'admin' } }, submissions: { s1: { status: 'pending' } } });
    const call = (submissionId, patch) => companySubmissionAction({ firestore: fs, verifyIdToken: verify, authorization: 'Bearer staff', op: 'update', submissionId, patch, now });
    assert.equal((await call('s1', { status: 'done' })).status, 400);
    assert.equal((await call('nope', { status: 'rejected' })).status, 404);
    assert.equal((await call('s1', { name: 'x' })).status, 400);
    assert.equal(fs.writes.length, 0);
});
