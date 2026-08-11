'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    buildDetailsFromRegistration,
    normaliseDetails,
    mergeDetails,
    hasAnyDetail,
    batteryLines,
    toDisplaySections,
} = require('../lib/snapshot');

/** A registered_products row shaped like the ones the wizard writes. */
const REGISTRATION = {
    customerName: 'Raju',
    customerPhone: '9043730533',
    customerEmail: 'raju@example.com',
    customerAddress: '12 Anna Salai, Chennai, Tamil Nadu, India',
    Serialnumber: '2505063529',
    productFamily: 'ongrid',
    modelnumber: 'FE-5.0-3P-OG',
    capacity: '5.0',
    Phase: '3',
    installerName: 'Muthu',
    installerContact: '9876543210',
    installationCompany: 'Rppl Solar',
    installationDate: '2026-05-30',
    installationAddressFull: '12 Anna Salai, Chennai, Tamil Nadu, India',
    warrantyEndDate: '2036-05-30',
};

/**
 * A row shaped like the ones the mobile app writes — different field names for
 * the same facts, a Timestamp warranty date and battery serials as bare strings.
 */
const MOBILE_REGISTRATION = {
    customerName: 'Asha',
    customerContact: '+919043730533',
    customerPhone: '9043730533',
    customerEmail: 'asha@example.com',
    customerAddress: '12 Anna Salai',
    customerCity: 'Chennai',
    customerState: 'Tamil Nadu',
    customerCountry: 'India',
    serialnumber: '2505063529',
    family: 'hybrid',
    productFamily: 'hybrid',
    inverterModel: 'FE-5.0-3P-HY',
    inverterSerial: '2505063529',
    installerName: 'Muthu',
    installerContact: '+919876543210',
    installationCompany: 'Rppl Solar',
    installationDate: '2026-05-30',
    installationAddress: '12 Anna Salai',
    installationCity: 'Chennai',
    installationState: 'Tamil Nadu',
    installationCountry: 'India',
    postalCode: '600032',
    wifiLogger: 'WL-88213004',
    warrantyEndDate: { seconds: Math.floor(Date.UTC(2036, 4, 30) / 1000) },
    batteryDetails: { purchased: true, brand: 'feston', festonBatteries: ['2401010001', '2401010002'] },
};

test('a registration document maps onto the snapshot', () => {
    const details = buildDetailsFromRegistration(REGISTRATION);
    assert.equal(details.customer.name, 'Raju');
    assert.equal(details.product.serialNumber, '2505063529');
    assert.equal(details.installation.company, 'Rppl Solar');
    assert.equal(details.installation.warrantyEndDate, '2036-05-30');
});

test('a mobile-app row maps onto the same snapshot', () => {
    const details = buildDetailsFromRegistration(MOBILE_REGISTRATION);

    assert.equal(details.product.serialNumber, '2505063529');
    assert.equal(details.product.model, 'FE-5.0-3P-HY');
    assert.equal(details.product.productFamily, 'hybrid');
    assert.equal(details.installation.postalCode, '600032');
    assert.equal(details.installation.warrantyEndDate, '2036-05-30');
    assert.equal(details.customer.address, '12 Anna Salai, Chennai, Tamil Nadu, India');
    assert.equal(details.installation.address, '12 Anna Salai, Chennai, Tamil Nadu, India');
    // The bare number wins over the E.164 form.
    assert.equal(details.customer.phone, '9043730533');
});

test('an already-composed address does not repeat its city and state', () => {
    const details = buildDetailsFromRegistration({
        customerAddress: '12 Anna Salai, Chennai, Tamil Nadu, India',
        customerCity: 'Chennai',
        customerState: 'Tamil Nadu',
        customerCountry: 'India',
    });
    assert.equal(details.customer.address, '12 Anna Salai, Chennai, Tamil Nadu, India');
});

test('a battery-family row does not show "NA" as its model', () => {
    const details = buildDetailsFromRegistration({ ...MOBILE_REGISTRATION, inverterModel: 'NA' });
    assert.equal(details.product.model, '');
});

test('the address falls back to selectedAddress when customerAddress is absent', () => {
    const details = buildDetailsFromRegistration({ selectedAddress: 'Fallback address' });
    assert.equal(details.customer.address, 'Fallback address');
});

test('an empty registration produces a snapshot with nothing to confirm', () => {
    assert.equal(hasAnyDetail(buildDetailsFromRegistration({})), false);
    assert.equal(hasAnyDetail(null), false);
    assert.equal(hasAnyDetail(buildDetailsFromRegistration(REGISTRATION)), true);
});

test('caller-supplied details are reduced to the known fields', () => {
    const details = normaliseDetails({
        customer: { name: 'Asha', unexpected: 'dropped' },
        product: { serialNumber: '1234567890' },
        somethingElse: { nested: true },
    });
    assert.equal(details.customer.name, 'Asha');
    assert.equal(details.product.serialNumber, '1234567890');
    assert.equal(details.customer.unexpected, undefined);
    assert.equal(details.somethingElse, undefined);
});

test('supplied details fill the gaps in a registration rather than replacing it', () => {
    const merged = mergeDetails(
        buildDetailsFromRegistration(MOBILE_REGISTRATION),
        normaliseDetails({ product: { capacity: '5.0', phase: '3' } }),
    );

    // The two fields the document cannot supply.
    assert.equal(merged.product.capacity, '5.0');
    assert.equal(merged.product.phase, '3');
    // Everything the document did supply survives.
    assert.equal(merged.product.serialNumber, '2505063529');
    assert.equal(merged.customer.name, 'Asha');
    assert.equal(merged.installation.postalCode, '600032');
    assert.deepEqual(merged.batteryDetails, MOBILE_REGISTRATION.batteryDetails);
});

test('an empty supplied field does not blank out the registration', () => {
    const merged = mergeDetails(
        buildDetailsFromRegistration(MOBILE_REGISTRATION),
        normaliseDetails({ customer: { name: '' } }),
    );
    assert.equal(merged.customer.name, 'Asha');
});

test('display sections drop empty fields instead of showing dashes', () => {
    const sections = toDisplaySections(buildDetailsFromRegistration(REGISTRATION));
    const product = sections.find((s) => s.title === 'Product');
    const labels = product.rows.map((r) => r.label);
    assert.ok(labels.includes('Serial Number'));
    assert.ok(!labels.includes('Subcategory')); // absent on this row
});

test('display sections use the customer-facing wording', () => {
    const sections = toDisplaySections(buildDetailsFromRegistration(REGISTRATION));
    const value = (title, label) =>
        sections.find((s) => s.title === title).rows.find((r) => r.label === label).value;

    assert.equal(value('Product', 'Product'), 'On Grid Inverter');
    assert.equal(value('Product', 'Capacity'), '5 Kw');
    assert.equal(value('Product', 'Phase'), 'Three Phase');
    assert.equal(value('Installation', 'Installation Date'), '30 May 2026');
});

test('a snapshot with no data at all yields no sections', () => {
    assert.deepEqual(toDisplaySections(buildDetailsFromRegistration({})), []);
});

test('battery lines cover the three recorded shapes', () => {
    assert.deepEqual(batteryLines({ purchased: false }), ['No batteries purchased']);

    assert.deepEqual(
        batteryLines({
            purchased: true,
            brand: 'feston',
            festonBatteries: [{ sn: '2401010001', model: 'FB-5' }, { sn: '2401010002', model: '' }],
        }),
        ['2401010001 · FB-5', '2401010002'],
    );

    assert.deepEqual(
        batteryLines({ purchased: true, brand: 'other', otherBatteries: [{ brand: 'Exide', model: 'X1' }] }),
        ['Exide X1'],
    );

    assert.deepEqual(batteryLines(null), []);
});

test('battery lines cover the mobile shapes too', () => {
    // Feston serials arrive as bare strings from the app.
    assert.deepEqual(
        batteryLines({ purchased: true, brand: 'feston', festonBatteries: ['2401010001', '2401010002'] }),
        ['2401010001', '2401010002'],
    );

    // Other-brand entries carry a serial the wizard shape has no room for.
    assert.deepEqual(
        batteryLines({
            purchased: true,
            brand: 'other',
            otherBatteries: [{ brand: 'Exide', model: 'X1', serial: 'EX-99' }],
        }),
        ['Exide X1 · EX-99'],
    );
});

test('a battery section appears only when batteries were recorded', () => {
    const without = toDisplaySections(buildDetailsFromRegistration(REGISTRATION));
    assert.equal(without.some((s) => s.title === 'Batteries'), false);

    const withBatteries = toDisplaySections(
        buildDetailsFromRegistration({
            ...REGISTRATION,
            batteryDetails: { purchased: true, brand: 'other', otherBatteries: [{ brand: 'Exide', model: 'X1' }] },
        }),
    );
    assert.equal(withBatteries.some((s) => s.title === 'Batteries'), true);
});
