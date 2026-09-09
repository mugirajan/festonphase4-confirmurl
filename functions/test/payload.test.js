'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { payloadFields, webCompatFields, PAYLOAD_FIELDS, NEVER_COPIED } = require('../lib/payload');

/** A pending record carrying every field the app is documented to write. */
function fullPending() {
    const doc = {
        // Link machinery
        token: 'tok',
        status: 'pending',
        expiresAt: { toMillis: () => Date.now() },
        createdAt: { toMillis: () => Date.now() },
        completedAt: null,
        userId: 'uid_customer',
        serialDocId: 'serial_1',
        registeredProductId: 'should_not_travel',
        // Attribution
        registeredByInstallerId: 'inst_9',
        registeredByInstallerName: 'Muthu Kumar',
        registeredByInstallerPhone: '9876543210',
    };
    for (const field of PAYLOAD_FIELDS) doc[field] = `value_${field}`;
    return doc;
}

test('every documented payload field is copied', () => {
    const out = payloadFields(fullPending());
    for (const field of PAYLOAD_FIELDS) {
        assert.equal(out[field], `value_${field}`, `${field} should be copied`);
    }
});

test('installer attribution travels with the registration', () => {
    const out = payloadFields(fullPending());
    assert.equal(out.registeredByInstallerId, 'inst_9');
    assert.equal(out.registeredByInstallerName, 'Muthu Kumar');
    assert.equal(out.registeredByInstallerPhone, '9876543210');
});

test('link machinery never travels with the registration', () => {
    const out = payloadFields(fullPending());
    for (const field of NEVER_COPIED) {
        assert.ok(!(field in out), `${field} must not be copied onto the registration`);
    }
});

test('unknown keys are dropped rather than passed through', () => {
    // A client writing an extra field must not be able to put arbitrary keys on
    // a row the portal later trusts.
    const out = payloadFields({ ...fullPending(), isAdmin: true, selfRegisteredVerified: true });
    assert.equal(out.isAdmin, undefined);
    assert.equal(out.selfRegisteredVerified, undefined);
});

test('undefined is dropped but empty, false and zero are kept', () => {
    // Firestore rejects undefined outright. The others are real answers:
    // "the customer has no email" is not the same as "nobody asked".
    const out = payloadFields({
        customerEmail: '',
        wifiLogger: undefined,
        batteryDetails: null,
        postalCode: 0,
        producttype: false,
    });

    assert.ok('customerEmail' in out);
    assert.equal(out.customerEmail, '');
    assert.ok(!('wifiLogger' in out));
    assert.ok('batteryDetails' in out);
    assert.equal(out.batteryDetails, null);
    assert.equal(out.postalCode, 0);
    assert.equal(out.producttype, false);
});

test('an empty pending record yields an empty payload rather than throwing', () => {
    assert.deepEqual(payloadFields({}), {});
    assert.deepEqual(payloadFields(), {});
});

/*
 * The portal's field names.
 *
 * `registered_products` carries two conventions and the admin portal reads the
 * web one. Its certificate generator looks a registration up with
 * `where('Serialnumber', '==', serial)` — capital S — so a registration written
 * with only the mobile names is invisible to it, and an operator is told "No
 * registered product found" about a row that is plainly there.
 */
test('the portal can find a registration this function wrote', () => {
    const out = webCompatFields({
        serialnumber: '2209039993',
        inverterModel: 'FE-8.0-3P-HY',
        producttype: 'HYBRID',
        productFamily: 'hybrid',
        customerAddress: '12 Anna Salai, Chennai',
    });

    assert.equal(out.Serialnumber, '2209039993');
    assert.equal(out.name, 'FE-8.0-3P-HY');
    assert.equal(out.type, 'HYBRID');
    assert.equal(out.selectedProductType, 'hybrid');
    assert.equal(out.selectedAddress, '12 Anna Salai, Chennai');
});

test('the serial falls back to inverterSerial, the other name the app uses', () => {
    assert.equal(webCompatFields({ inverterSerial: '2209039994' }).Serialnumber, '2209039994');
});

test('an absent value emits no key rather than an empty one', () => {
    // An empty `Serialnumber` is worse than none: a query for '' would match it,
    // so a blank row could be returned as somebody's registration.
    const out = webCompatFields({ serialnumber: '   ', inverterModel: '' });
    assert.ok(!('Serialnumber' in out));
    assert.ok(!('name' in out));
    assert.deepEqual(webCompatFields({}), {});
    assert.deepEqual(webCompatFields(), {});
});

test('the fields the certificate prints survive the copy', () => {
    // Phase and capacity are ON the certificate and were on the pending record
    // all along — they were simply never in the allowlist, so they never
    // reached the registration.
    const out = payloadFields({
        Phase: '3',
        capacity: '8',
        submodel: 'Rack',
        invoiceUrl: 'https://example.test/invoice.pdf',
        installationPhoto1Url: '',
        installationPhoto2Url: '',
    });

    assert.equal(out.Phase, '3');
    assert.equal(out.capacity, '8');
    assert.equal(out.submodel, 'Rack');
    assert.equal(out.invoiceUrl, 'https://example.test/invoice.pdf');
    assert.ok('installationPhoto1Url' in out);
    assert.ok('installationPhoto2Url' in out);
});
