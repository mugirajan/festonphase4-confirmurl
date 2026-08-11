'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { payloadFields, PAYLOAD_FIELDS, NEVER_COPIED } = require('../lib/payload');

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
