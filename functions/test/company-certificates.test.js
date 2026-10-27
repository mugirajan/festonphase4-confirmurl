'use strict';

// The company admin's Certificates page reads its customers' Super Hero
// numbers (2026-10-22) and which registrations have issued files
// (2026-10-27) through the confirm service. The files themselves:
// test/certificate-files.test.js.

const test = require('node:test');
const assert = require('node:assert');
const { listCompanyHeroCertificates } = require('../lib/company-certificates');

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

const verifyIdToken = async (t) => ({ uid: { 'tok-admin': 'admin_1', 'tok-eng': 'eng_1' }[t] });
const call = (fs, token) => listCompanyHeroCertificates({ firestore: fs, verifyIdToken, authorization: `Bearer ${token}` });

const DOCS = {
    'admins/admin_1': { role: 'company-admin', companyId: 'co_9' },
    'registered_products/r1': { companyId: 'co_9', userId: 'cust_a', serialnumber: 'SN-R1' },
    'registered_products/r2': { companyId: 'co_9', userId: 'cust_a' },
    'registered_products/r3': { companyId: 'co_9', userId: 'cust_b' },
    'registered_products/r4': { companyId: 'co_OTHER', userId: 'cust_c', serialnumber: 'SN-R4' },
    'hero_certificates/cust_a': { certificateNumber: 'FSV-SSH-2026-00011', status: 'ready' },
    'hero_certificates/cust_c': { certificateNumber: 'FSV-SSH-2026-00099', status: 'ready' },
    // r1: both issued. r2: warranty still rendering. r3: nothing. r4: issued, other company.
    'warranty_certificates/r1': { status: 'ready', pdfPath: 'warranty-certificates/cust_a/r1.pdf', serialnumber: 'SN-R1' },
    'test_reports/r1': { status: 'ready', pdfPath: 'test-reports/cust_a/r1.pdf', serialnumber: 'SN-R1' },
    'warranty_certificates/r2': { status: 'rendering' },
    'warranty_certificates/r4': { status: 'ready', pdfPath: 'warranty-certificates/cust_c/r4.pdf', serialnumber: 'SN-R4' },
};

test("returns only the own company's customers' certificate numbers", async () => {
    const r = await call(fakeFirestore(DOCS), 'tok-admin');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.heroes, { cust_a: { certificateNumber: 'FSV-SSH-2026-00011', status: 'ready' } });
});

test('says which registrations have issued files, and only ready ones', async () => {
    const r = await call(fakeFirestore(DOCS), 'tok-admin');
    assert.deepEqual(r.body.files, { r1: { warranty: true, test: true } });
});

test('refuses anyone who is not a company admin', async () => {
    assert.equal((await call(fakeFirestore(DOCS), 'tok-eng')).status, 403);
    assert.equal((await listCompanyHeroCertificates({ firestore: fakeFirestore(DOCS), verifyIdToken, authorization: '' })).status, 401);
});
