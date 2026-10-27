'use strict';

// A decided points claim leaves the engineer a notification (2026-10-26).

const test = require('node:test');
const assert = require('node:assert');
const { notifyClaimDecision, compose } = require('../lib/claim-notify');

/** Docs by path; `collection(c).doc(id).get()/set()` is all the module uses. */
function fakeFirestore(seed = {}) {
    const docs = new Map(Object.entries(seed));
    return {
        docs,
        collection: (col) => ({
            doc: (id) => ({
                id,
                async get() {
                    const data = docs.get(`${col}/${id}`);
                    return { id, exists: data !== undefined, data: () => data };
                },
                async set(data) {
                    docs.set(`${col}/${id}`, data);
                },
            }),
        }),
    };
}

const verify = async (t) => {
    const map = { 'tok-staff': 'uid_staff', 'tok-co': 'uid_co', 'tok-eng': 'uid_eng' };
    if (map[t]) return { uid: map[t] };
    throw new Error('bad token');
};

const seed = () => ({
    'admins/uid_staff': { role: 'reward-points', name: 'Feston reviewer' },
    'admins/uid_co': { role: 'company-admin', companyId: 'co1' },
    'points_claims/c1': {
        installerId: 'uid_eng',
        action: 'eb_bill_before_after',
        label: 'EB bill, before and after',
        customerName: 'Kamalraj',
        serialnumber: '2209031044',
        registrationId: 'reg1',
        status: 'rejected',
        awardedPoints: 0,
        revokedPoints: 50,
        decisionMessage: 'this photo is not accurate',
    },
    'points_claims/c2': { installerId: 'uid_eng', label: 'Google review for Feston', status: 'pending' },
});

const call = (fs, token, body) =>
    notifyClaimDecision({ firestore: fs, verifyIdToken: verify, authorization: token ? `Bearer ${token}` : undefined, body, now: () => 'NOW' });

test('no token -> 401; a company admin -> 403; an engineer -> 403', async () => {
    const fs = fakeFirestore(seed());
    assert.equal((await call(fs, null, { claimId: 'c1' })).status, 401);
    assert.equal((await call(fs, 'tok-co', { claimId: 'c1' })).status, 403);
    assert.equal((await call(fs, 'tok-eng', { claimId: 'c1' })).status, 403);
    assert.equal([...fs.docs.keys()].filter((k) => k.startsWith('installer_notifications/')).length, 0);
});

test('a take-back leaves the engineer a notification naming the photo, the customer, the points and the reason', async () => {
    const fs = fakeFirestore(seed());
    const r = await call(fs, 'tok-staff', { claimId: 'c1' });
    assert.equal(r.status, 200);
    const n = fs.docs.get('installer_notifications/claim_rejected_c1');
    assert.ok(n, 'written under a fixed id');
    assert.equal(n.installerUid, 'uid_eng');
    assert.equal(n.kind, 'claim-rejected');
    assert.equal(n.title, '50 points taken back');
    assert.match(n.message, /"EB bill, before and after" photo for Kamalraj \(SN 2209031044\)/);
    assert.match(n.message, /took back the 50 points/);
    assert.match(n.message, /Reason: this photo is not accurate/);
    assert.equal(n.points, 50);
    assert.equal(n.registrationId, 'reg1');
    assert.equal(n.read, false);
});

test('calling twice for the same decision does not post twice', async () => {
    const fs = fakeFirestore(seed());
    await call(fs, 'tok-staff', { claimId: 'c1' });
    await call(fs, 'tok-staff', { claimId: 'c1' });
    assert.equal([...fs.docs.keys()].filter((k) => k.startsWith('installer_notifications/')).length, 1);
});

test('a claim still waiting -> 409, nothing written; an unknown claim -> 404', async () => {
    const fs = fakeFirestore(seed());
    assert.equal((await call(fs, 'tok-staff', { claimId: 'c2' })).status, 409);
    assert.equal((await call(fs, 'tok-staff', { claimId: 'nope' })).status, 404);
    assert.equal([...fs.docs.keys()].filter((k) => k.startsWith('installer_notifications/')).length, 0);
});

test('a rejection of a never-paid claim says "not approved" rather than quoting points', () => {
    const n = compose({ label: 'Google review for Feston', status: 'rejected', awardedPoints: 0, decisionMessage: 'no review found' });
    assert.equal(n.title, 'Points claim not approved');
    assert.match(n.message, /did not approve your "Google review for Feston" claim/);
    assert.match(n.message, /Reason: no review found/);
});

test('an approval reads as points credited', () => {
    const n = compose({ label: 'Video testimonial', status: 'approved', awardedPoints: 100, customerName: 'Raju' });
    assert.equal(n.kind, 'claim-approved');
    assert.equal(n.title, '100 points credited');
    assert.match(n.message, /approved your "Video testimonial" claim for Raju/);
});
