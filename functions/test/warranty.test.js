'use strict';

// The warranty certificate issued with the Solar Super Hero one (2026-10-22).

const test = require('node:test');
const assert = require('node:assert');
const {
    detailFrom,
    warrantyFields,
    hybridBlockFields,
    warrantyHtml,
    issueWarranty,
    warrantyFilename,
} = require('../lib/warranty-certificate');
const { buildMailDocument, buildWarrantyMailDocument } = require('../lib/hero-mail');

const ONGRID = {
    userId: 'cust_1',
    serialnumber: '2209040013',
    productFamily: 'ongrid',
    inverterModel: 'FE-15.0-3P-OG',
    customerName: 'Kamal',
    customerEmail: 'kamal@example.com',
    customerCountry: 'India',
    installationDate: '2026-10-20',
    warrantyEndDate: '2036-10-20',
    installationCompany: 'Black I Technology & Solutions',
    installationAddress: '12 Gandhi St',
    installationCity: 'Chennai',
    installationState: 'Tamil Nadu',
    installationCountry: 'India',
    postalCode: '600040',
    wifiLogger: 'WLTEST0013',
};

const HYBRID = {
    ...ONGRID,
    serialnumber: '2209040029',
    productFamily: 'hybrid',
    inverterModel: 'FE-8.0-3P-HY',
    batteryDetails: {
        brand: 'feston',
        festonBatteries: [
            { sn: 'TSTBATRACK000001', model: 'FES-5K-Rack' },
            { sn: 'TSTBATRACK000002', model: 'FES-5K-Rack' },
        ],
    },
};

/** Just enough Firestore for issueWarranty: one collection of plain docs. */
function fakeFirestore() {
    const docs = new Map();
    return {
        docs,
        collection: (name) => ({
            doc: (id) => ({
                get: async () => ({ exists: docs.has(`${name}/${id}`), data: () => docs.get(`${name}/${id}`) }),
                set: async (data, opts) => {
                    const key = `${name}/${id}`;
                    docs.set(key, opts && opts.merge ? { ...(docs.get(key) || {}), ...data } : data);
                },
            }),
        }),
    };
}

function fakeDeps() {
    const saved = [];
    let renders = 0;
    return {
        saved,
        renders: () => renders,
        renderLayout: async () => {
            renders += 1;
            return { pdf: Buffer.from('%PDF'), png: Buffer.from('PNG') };
        },
        bucket: () => ({ file: (path) => ({ save: async () => saved.push(path) }) }),
    };
}

test('the standard certificate lists the same fields, in the same order, as the app', () => {
    const fields = warrantyFields(detailFrom(ONGRID));
    assert.deepEqual(
        fields.map((f) => f.label),
        [
            'Country of Registration',
            'Date of Installation',
            'End Date of Warranty',
            'Installation Company',
            'Installation Address',
            'Product Model',
            'Product Serial',
            'Wifi Logger',
        ],
    );
    assert.equal(fields[4].value, '12 Gandhi St, Chennai, 600040, Tamil Nadu, India');
    assert.equal(fields[2].value, '2036-10-20');
});

test('a Firestore Timestamp warranty end date prints as a plain date', () => {
    const ts = { toDate: () => new Date('2036-10-22T00:00:00Z') };
    assert.equal(detailFrom({ ...ONGRID, warrantyEndDate: ts }).warrantyEndDate, '2036-10-22');
});

test('hybrids get the hybrid layout, with every battery serial and the model once', () => {
    const html = warrantyHtml(HYBRID);
    assert.match(html, /FESTON HYBRID WARRANTY/);
    const block = hybridBlockFields(detailFrom(HYBRID));
    assert.equal(block.find((f) => f.label === 'Battery Serial:').value, 'TSTBATRACK000001, TSTBATRACK000002');
    assert.equal(block.find((f) => f.label === 'Battery Model:').value, 'FES-5K-Rack');
    assert.doesNotMatch(warrantyHtml(ONGRID), /FESTON HYBRID WARRANTY/);
    assert.match(warrantyHtml(ONGRID), /10 YEARS/);
});

test('customer-typed text is escaped, never injected into the page', () => {
    const html = warrantyHtml({ ...ONGRID, customerName: '<script>x</script>' });
    assert.doesNotMatch(html, /<script>x<\/script>/);
    assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
});

test('issued once per registration: a retry re-uses the files instead of rendering again', async () => {
    const fs = fakeFirestore();
    const deps = fakeDeps();

    const first = await issueWarranty(fs, 'reg_1', ONGRID, deps);
    assert.equal(first.status, 'ready');
    assert.equal(first.pdfPath, 'warranty-certificates/cust_1/reg_1.pdf');
    assert.equal(first.serialnumber, '2209040013');
    assert.deepEqual(deps.saved.sort(), [
        'warranty-certificates/cust_1/reg_1.pdf',
        'warranty-certificates/cust_1/reg_1.png',
    ]);

    const again = await issueWarranty(fs, 'reg_1', ONGRID, deps);
    assert.equal(deps.renders(), 1, 'not rendered a second time');
    assert.equal(again.pdfPath, first.pdfPath);
});

test('the hero email carries the warranty PDF as a third attachment', () => {
    const doc = buildMailDocument({
        to: 'kamal@example.com',
        customerName: 'Kamal',
        certificateNumber: 'FSH-2026-000001',
        co2Tonnes: 18,
        trees: 820,
        pngUrl: 'https://x/hero.png',
        pdfUrl: 'https://x/hero.pdf',
        warranty: { url: 'https://x/w.pdf', filename: warrantyFilename('2209040013'), serial: '2209040013' },
    });
    assert.deepEqual(
        doc.message.attachments.map((a) => a.filename),
        ['FSH-2026-000001.png', 'FSH-2026-000001.pdf', 'Warranty-2209040013.pdf'],
    );
    assert.match(doc.message.text, /and warranty certificate for serial 2209040013 are attached/);
    assert.match(doc.message.html, /and warranty certificate for serial 2209040013 are attached/);

    const without = buildMailDocument({
        to: 'kamal@example.com',
        certificateNumber: 'FSH-2026-000001',
        pngUrl: 'p',
        pdfUrl: 'q',
    });
    assert.equal(without.message.attachments.length, 2, 'no warranty, no third attachment');
    assert.doesNotMatch(without.message.text, /warranty/i);
});

test('the warranty-only email names the serial and attaches the PDF', () => {
    const doc = buildWarrantyMailDocument({
        to: 'kamal@example.com',
        customerName: 'Kamal Raj',
        serialnumber: '2209040013',
        url: 'https://x/w.pdf',
        filename: 'Warranty-2209040013.pdf',
    });
    assert.equal(doc.message.subject, 'Kamal, your Feston warranty certificate');
    assert.deepEqual(doc.message.attachments, [{ filename: 'Warranty-2209040013.pdf', path: 'https://x/w.pdf' }]);
    assert.match(doc.message.text, /serial 2209040013/);
});
