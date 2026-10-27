'use strict';

// Companies typed by hand at registration (2026-10-27): recorded for Feston to
// verify, never blocking the registration, one record per company + phone.

const test = require('node:test');
const assert = require('node:assert');
const { recordCompanySubmission, submissionId, nameKey } = require('../lib/company-submissions');

function fakeFirestore(docs) {
    const key = (c, id) => `${c}/${id}`;
    return {
        docs,
        collection: (c) => ({
            doc: (id) => ({
                get: async () => ({ exists: docs.has(key(c, id)), data: () => docs.get(key(c, id)) }),
                set: async (data, opts) => {
                    const prev = docs.get(key(c, id));
                    docs.set(key(c, id), opts && opts.merge && prev ? { ...prev, ...data } : data);
                },
            }),
            where: (field, _op, value) => ({
                limit: () => ({
                    get: async () => {
                        const out = [];
                        for (const [k, d] of docs) if (k.startsWith(`${c}/`) && d[field] === value) out.push({ id: k.split('/')[1], data: () => d });
                        return { empty: out.length === 0, docs: out };
                    },
                }),
            }),
        }),
    };
}

const ROW = {
    installationCompany: 'Sun Solars',
    installerName: 'Harry Potter',
    installerContact: '+91 91111 11111',
    customerName: 'Kamalraj',
    customerContact: '+918056221146',
    serialnumber: '2209031044',
};
const NOW = new Date('2026-10-27T10:00:00Z');

test('ids are stable for the same company however it is typed', () => {
    assert.equal(nameKey(' Sun Solars Pvt. Ltd '), 'sunsolarspvtltd');
    assert.equal(submissionId('Sun Solars', '+91 91111 11111'), 'sunsolars__9111111111');
    assert.equal(submissionId('SUN  solars', '9111111111'), 'sunsolars__9111111111');
    assert.equal(submissionId('', ''), 'unnamed__nophone');
});

test('a typed company with no Feston company behind it is recorded as pending', async () => {
    const fs = fakeFirestore(new Map());
    const r = await recordCompanySubmission(fs, { registrationId: 'reg1', row: ROW, source: 'customer', now: NOW });
    assert.deepEqual(r, { recorded: true, id: 'sunsolars__9111111111', created: true });
    const doc = fs.docs.get('company_submissions/sunsolars__9111111111');
    assert.equal(doc.status, 'pending');
    assert.equal(doc.name, 'Sun Solars');
    assert.equal(doc.installerName, 'Harry Potter');
    assert.equal(doc.customerName, 'Kamalraj');
    assert.deepEqual(doc.registrationIds, ['reg1']);
    assert.deepEqual(doc.serialnumbers, ['2209031044']);
    assert.equal(doc.registrationCount, 1);
});

test('a second registration naming the same company joins the same record', async () => {
    const fs = fakeFirestore(new Map());
    await recordCompanySubmission(fs, { registrationId: 'reg1', row: ROW, now: NOW });
    const r = await recordCompanySubmission(fs, {
        registrationId: 'reg2',
        batteryRegistrationIds: ['bat1'],
        row: { ...ROW, installationCompany: 'SUN SOLARS', serialnumber: '2209031045' },
        now: NOW,
    });
    assert.equal(r.created, false);
    const doc = fs.docs.get('company_submissions/sunsolars__9111111111');
    assert.deepEqual(doc.registrationIds, ['reg1', 'reg2', 'bat1']);
    assert.deepEqual(doc.serialnumbers, ['2209031044', '2209031045']);
    assert.equal(doc.registrationCount, 3);
    assert.equal(doc.status, 'pending');
});

test('a rejected company that turns up again stays rejected, with the new count', async () => {
    const docs = new Map([['company_submissions/sunsolars__9111111111', { status: 'rejected', registrationIds: ['old'], serialnumbers: ['S0'] }]]);
    await recordCompanySubmission(fakeFirestore(docs), { registrationId: 'reg9', row: ROW, now: NOW });
    const doc = docs.get('company_submissions/sunsolars__9111111111');
    assert.equal(doc.status, 'rejected');
    assert.deepEqual(doc.registrationIds, ['old', 'reg9']);
});

test('nothing is recorded for a registration with a company, a known company, or no name', async () => {
    const docs = new Map([['companies/co_9', { name: 'Sun Solars' }]]);
    assert.deepEqual(await recordCompanySubmission(fakeFirestore(new Map()), { registrationId: 'r', row: { ...ROW, companyId: 'co_1' } }), { recorded: false, reason: 'has-company', companyId: 'co_1' });
    assert.deepEqual(await recordCompanySubmission(fakeFirestore(docs), { registrationId: 'r', row: ROW }), { recorded: false, reason: 'known-company', companyId: 'co_9' });
    assert.deepEqual(await recordCompanySubmission(fakeFirestore(new Map()), { registrationId: 'r', row: { ...ROW, installationCompany: '' } }), { recorded: false, reason: 'no-company-name' });
    assert.equal(docs.size, 1, 'nothing written');
});
