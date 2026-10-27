'use strict';

// One issued certificate file, for whoever is entitled to it (2026-10-27):
// the customer, the installer's company admin, or Feston staff.

const test = require('node:test');
const assert = require('node:assert');
const { certificateFile } = require('../lib/certificate-files');

function fakeFirestore(docs) {
    const snap = (path) => ({ id: path.split('/')[1], exists: docs[path] !== undefined, data: () => docs[path] });
    const ref = (col, id) => ({ path: `${col}/${id}`, get: async () => snap(`${col}/${id}`) });
    return {
        collection: (col) => ({
            doc: (id) => ref(col, id),
            where: (field, _op, value) => ({
                limit: () => ({
                    get: async () => ({
                        docs: Object.keys(docs)
                            .filter((k) => k.startsWith(`${col}/`) && docs[k][field] === value)
                            .map((k) => snap(k)),
                    }),
                }),
            }),
        }),
        getAll: async (...refs) => refs.map((r) => snap(r.path)),
    };
}

const TOKENS = { 'tok-admin': 'admin_1', 'tok-staff': 'staff_1', 'tok-cust-a': 'cust_a', 'tok-cust-c': 'cust_c', 'tok-eng': 'eng_1' };
const verifyIdToken = async (t) => {
    if (!TOKENS[t]) throw new Error('bad token');
    return { uid: TOKENS[t] };
};

const DOCS = {
    'admins/admin_1': { role: 'company-admin', companyId: 'co_9' },
    'admins/staff_1': { role: 'crm' },
    'registered_products/r1': { companyId: 'co_9', userId: 'cust_a', serialnumber: 'SN-R1' },
    'registered_products/r2': { companyId: 'co_9', userId: 'cust_a', serialnumber: 'SN-R2' },
    'registered_products/r4': { companyId: 'co_OTHER', userId: 'cust_c', serialnumber: 'SN-R4' },
    'warranty_certificates/r1': { status: 'ready', pdfPath: 'warranty-certificates/cust_a/r1.pdf', pngPath: 'warranty-certificates/cust_a/r1.png', serialnumber: 'SN-R1' },
    'test_reports/r1': { status: 'ready', pdfPath: 'test-reports/cust_a/r1.pdf', serialnumber: 'SN-R1' },
    'warranty_certificates/r2': { status: 'rendering' },
    'warranty_certificates/r4': { status: 'ready', pdfPath: 'warranty-certificates/cust_c/r4.pdf', serialnumber: 'SN-R4' },
};

const call = (token, args, read = []) =>
    certificateFile({
        firestore: fakeFirestore(DOCS),
        verifyIdToken,
        authorization: token ? `Bearer ${token}` : '',
        readObject: async (p) => {
            read.push(p);
            return Buffer.from(`bytes:${p}`);
        },
        ...args,
    });

test('the customer gets their own file, as PDF or PNG, named by serial', async () => {
    const read = [];
    const pdf = await call('tok-cust-a', { registrationId: 'r1', kind: 'warranty' }, read);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.file.filename, 'Warranty-SN-R1.pdf');
    assert.equal(pdf.file.contentType, 'application/pdf');
    const png = await call('tok-cust-a', { registrationId: 'r1', kind: 'warranty', variant: 'png' }, read);
    assert.equal(png.file.filename, 'Warranty-SN-R1.png');
    assert.equal(png.file.contentType, 'image/png');
    const rep = await call('tok-cust-a', { registrationId: 'r1', kind: 'test' }, read);
    assert.equal(rep.file.filename, 'Test-Report-SN-R1.pdf');
    assert.deepEqual(read, ['warranty-certificates/cust_a/r1.pdf', 'warranty-certificates/cust_a/r1.png', 'test-reports/cust_a/r1.pdf']);
});

test("a customer never gets another customer's file, and cannot tell it exists", async () => {
    const r = await call('tok-cust-c', { registrationId: 'r1', kind: 'warranty' });
    assert.equal(r.status, 404);
    assert.equal(r.body.status, 'not-found');
});

test("the company admin gets their company's files only", async () => {
    assert.equal((await call('tok-admin', { registrationId: 'r1', kind: 'warranty' })).status, 200);
    assert.equal((await call('tok-admin', { registrationId: 'r4', kind: 'warranty' })).status, 404);
});

test('Feston staff get any file, by registration id or by serial', async () => {
    assert.equal((await call('tok-staff', { registrationId: 'r4', kind: 'warranty' })).status, 200);
    const bySerial = await call('tok-staff', { serialnumber: 'SN-R1', kind: 'test' });
    assert.equal(bySerial.status, 200);
    assert.equal(bySerial.file.filename, 'Test-Report-SN-R1.pdf');
    assert.equal((await call('tok-staff', { serialnumber: 'SN-NONE', kind: 'test' })).status, 404);
});

test('says when nothing is issued yet, without touching Storage', async () => {
    const read = [];
    assert.equal((await call('tok-cust-a', { registrationId: 'r2', kind: 'warranty' }, read)).body.status, 'not-issued');
    assert.equal((await call('tok-cust-a', { registrationId: 'r2', kind: 'test' }, read)).body.status, 'not-issued');
    assert.deepEqual(read, []);
});

test('rejects bad requests and bad tokens', async () => {
    assert.equal((await call('tok-cust-a', { registrationId: 'r1', kind: 'hero' })).status, 400);
    assert.equal((await call('tok-cust-a', { registrationId: 'r1', kind: 'test', variant: 'png' })).status, 400);
    assert.equal((await call('', { registrationId: 'r1', kind: 'warranty' })).status, 401);
    assert.equal((await call('tok-nobody', { registrationId: 'r1', kind: 'warranty' })).status, 401);
});
