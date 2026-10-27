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
const { LOGO_CID, fileAttachments } = require('../lib/mail-logo');
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
    assert.equal(fields[4].value, '12 Gandhi St, Chennai, Tamil Nadu, 600040, India');
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
    // One layout for all (2026-10-27): the on-grid gets the gold frame too, with its own title and no battery rows.
    const ongrid = warrantyHtml(ONGRID);
    assert.doesNotMatch(ongrid, /FESTON HYBRID WARRANTY/);
    assert.match(ongrid, /FESTON ON-GRID WARRANTY/);
    assert.match(ongrid, /Standard warranty · 10 years/);
    assert.doesNotMatch(ongrid, /Battery Serial/);
    assert.match(ongrid, /Logger no/);
});

test('warranty years follow the product (2026-10-27)', () => {
    const { warrantyYearsOf } = require('../lib/warranty-certificate');
    const noDates = { ...ONGRID, installationDate: '', warrantyEndDate: '' };
    assert.equal(warrantyYearsOf({ ...noDates, warrantyYears: 5 }), 5, 'the stamped value wins');
    assert.equal(warrantyYearsOf(ONGRID), 10, 'read from the dates when not stamped');
    assert.equal(warrantyYearsOf({ ...noDates, productFamily: 'batteries' }), 5, 'a battery row is 5');
    assert.equal(warrantyYearsOf({ ...noDates, productFamily: 'hybrid', submodel: 'HV' }), 5, 'HV hybrid, no battery');
    assert.equal(warrantyYearsOf({ ...noDates, productFamily: 'hybrid', submodel: 'HV', batteryDetails: { purchased: true, brand: 'feston' } }), 10, 'HV hybrid with a Feston battery');
    assert.equal(warrantyYearsOf({ ...noDates, productFamily: 'hybrid', submodel: 'HV', batteryDetails: { purchased: true, brand: 'other' } }), 5, 'HV hybrid with another brand');
    assert.equal(warrantyYearsOf({ ...noDates, productFamily: 'hybrid', submodel: 'LV' }), 10, 'LV hybrid');
    const battery = warrantyHtml({ ...noDates, productFamily: 'batteries', warrantyYears: 5 });
    assert.match(battery, /FESTON BATTERY WARRANTY/);
    assert.match(battery, /Standard warranty · 5 years/);
    assert.doesNotMatch(battery, /10 years/);
    assert.match(battery, /Battery Model/);
    assert.doesNotMatch(battery, /Inverter Model|Logger no/);
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
        fileAttachments(doc.message.attachments).map((a) => a.filename),
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
    assert.equal(fileAttachments(without.message.attachments).length, 2, 'no warranty, no third attachment');
    assert.doesNotMatch(without.message.text, /warranty/i);
});

test("the batteries' certificates ride in the same email, and the mail says so (2026-10-27)", () => {
    const extras = [
        { serial: 'TSTBATRACK000001', url: 'https://x/b1.pdf', filename: 'Warranty-TSTBATRACK000001.pdf', testReportUrl: 'https://x/b1t.pdf', testReportFilename: 'Test-Report-TSTBATRACK000001.pdf' },
        { serial: 'TSTBATRACK000002', url: 'https://x/b2.pdf', filename: 'Warranty-TSTBATRACK000002.pdf', testReportUrl: '', testReportFilename: '' },
    ];
    const hero = buildMailDocument({
        to: 'kamal@example.com',
        customerName: 'Kamal Raj',
        certificateNumber: 'FSH-2026-000001',
        co2Tonnes: 7,
        trees: 820,
        pngUrl: 'https://x/hero.png',
        pdfUrl: 'https://x/hero.pdf',
        warranty: { url: 'https://x/w.pdf', filename: warrantyFilename('2209040013'), serial: '2209040013' },
        extras,
    });
    assert.deepEqual(
        fileAttachments(hero.message.attachments).map((a) => a.filename),
        ['FSH-2026-000001.png', 'FSH-2026-000001.pdf', 'Warranty-2209040013.pdf', 'Warranty-TSTBATRACK000001.pdf', 'Test-Report-TSTBATRACK000001.pdf', 'Warranty-TSTBATRACK000002.pdf'],
    );
    assert.match(hero.message.text, /each of the 2 Feston batteries installed with it \(serial TSTBATRACK000001, TSTBATRACK000002\)/);
    assert.match(hero.message.html, /each of the 2 Feston batteries/);

    const only = buildWarrantyMailDocument({
        to: 'kamal@example.com',
        customerName: 'Kamal Raj',
        serialnumber: '2209040013',
        url: 'https://x/w.pdf',
        filename: 'Warranty-2209040013.pdf',
        extras: [extras[1]],
    });
    assert.deepEqual(fileAttachments(only.message.attachments).map((a) => a.filename), ['Warranty-2209040013.pdf', 'Warranty-TSTBATRACK000002.pdf']);
    assert.match(only.message.text, /the warranty certificate for the Feston battery installed with it \(serial TSTBATRACK000002\)/);
});

test("the warranty-only email carries the customer's Super Hero certificate too (2026-10-27)", () => {
    const doc = buildWarrantyMailDocument({
        to: 'kamal@example.com',
        customerName: 'Kamal Raj',
        serialnumber: '2209040013',
        url: 'https://x/w.pdf',
        filename: 'Warranty-2209040013.pdf',
        hero: { number: 'FSV-SSH-2026-00011', pngUrl: 'https://x/h.png', pdfUrl: 'https://x/h.pdf' },
    });
    assert.deepEqual(fileAttachments(doc.message.attachments).map((a) => a.filename), ['Warranty-2209040013.pdf', 'FSV-SSH-2026-00011.png', 'FSV-SSH-2026-00011.pdf']);
    assert.match(doc.message.text, /Solar Super Hero certificate \(No\. FSV-SSH-2026-00011\) is attached as well/);
    assert.match(doc.message.html, /Solar Super Hero certificate/);
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
    assert.deepEqual(fileAttachments(doc.message.attachments), [{ filename: 'Warranty-2209040013.pdf', path: 'https://x/w.pdf' }]);
    assert.equal(doc.message.attachments[0].cid, 'feston-logo', 'the logo leads every mail');
    assert.match(doc.message.text, /serial 2209040013/);
});
