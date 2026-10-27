'use strict';

// One registration row per Feston battery (2026-10-27): what it copies from the
// inverter's row, what is its own, and the 5-year warranty.

const test = require('node:test');
const assert = require('node:assert');
const { festonBatteriesOf, batteryRow, batteryWarrantyEnd } = require('../lib/battery-rows');

const INVERTER = {
    userId: 'cust_a',
    customerName: 'Kamal Raj',
    customerEmail: 'kamal@example.com',
    installationDate: '2026-10-27',
    installationCompany: 'Sun Solars',
    installationAddress: 'No. 7A, Jeeva nagar',
    installationCity: 'Chennai',
    postalCode: '600091',
    registeredByInstallerId: 'eng_1',
    companyId: 'co_9',
    customerConfirmed: true,
    customerConfirmedAt: 'T1',
    isDetailsCorrect: true,
    serialnumber: '2209040029',
    productFamily: 'hybrid',
    inverterModel: 'FE-8.0-3P-HY',
    submodel: 'HV',
    capacityKw: 8,
    warrantyYears: 10,
    warrantyEndDate: '2036-10-27',
    batteryDetails: { purchased: true, brand: 'feston', festonBatteries: [{ sn: 'B1', model: 'FES-5K-Rack' }, { sn: 'B2', model: 'FES-5K-Rack' }] },
    token: 'never-copied',
};

test('festonBatteriesOf reads every shape the batteries were ever stored in', () => {
    assert.deepEqual(festonBatteriesOf({ batteryDetails: { brand: 'feston', festonBatteries: ['S1', { sn: 'S2', model: 'M', subtype: 'Wall', capacityKw: '5' }, { serial: 'S3' }, {}] } }), [
        { serial: 'S1', model: '', subtype: '', capacityKw: null },
        { serial: 'S2', model: 'M', subtype: 'Wall', capacityKw: 5 },
        { serial: 'S3', model: '', subtype: '', capacityKw: null },
    ]);
    assert.deepEqual(festonBatteriesOf({ batteryDetails: { brand: 'other', otherBatteries: [{ serial: 'X' }] } }), []);
    assert.deepEqual(festonBatteriesOf({ batteryDetails: { purchased: false } }), []);
    assert.deepEqual(festonBatteriesOf({}), []);
});

test('a battery row is the same install with its own product and a 5-year warranty', () => {
    const row = batteryRow(INVERTER, { serial: 'B1', model: 'FES-5K-Rack', subtype: 'Rack', capacityKw: 5 }, {
        parentRegistrationId: 'reg_inv',
        toTimestamp: (d) => ({ iso: d.toISOString().slice(0, 10) }),
    });
    // Copied from the inverter: who, where, who installed it.
    assert.equal(row.userId, 'cust_a');
    assert.equal(row.customerName, 'Kamal Raj');
    assert.equal(row.installationCompany, 'Sun Solars');
    assert.equal(row.installationDate, '2026-10-27');
    assert.equal(row.companyId, 'co_9');
    assert.equal(row.customerConfirmed, true, 'confirmed with the inverter');
    assert.equal(row.customerConfirmedAt, 'T1');
    assert.equal(row.isDetailsCorrect, true);
    // Its own.
    assert.equal(row.serialnumber, 'B1');
    assert.equal(row.Serialnumber, 'B1');
    assert.equal(row.productFamily, 'batteries');
    assert.equal(row.producttype, 'BATTERIES');
    assert.equal(row.inverterModel, 'FES-5K-Rack');
    assert.equal(row.submodel, 'Rack');
    assert.equal(row.kilowatt, 5);
    assert.equal(row.capacityKw, null);
    assert.equal(row.parentRegistrationId, 'reg_inv');
    assert.equal(row.batterySerial, 'B1');
    assert.deepEqual(row.batteryDetails.festonBatteries.map((b) => b.sn), ['B1']);
    // Not the inverter's.
    assert.equal(row.token, undefined);
    assert.equal(row.warrantyYears, 5);
    assert.deepEqual(row.warrantyEndDate, { iso: '2031-10-27' });
});

test('the warranty end follows the installation date, five years on', () => {
    assert.equal(batteryWarrantyEnd('2026-02-28').toISOString().slice(0, 10), '2031-02-28');
    assert.equal(batteryWarrantyEnd({ toDate: () => new Date('2026-10-27T00:00:00Z') }).toISOString().slice(0, 10), '2031-10-27');
    assert.equal(batteryWarrantyEnd('not a date'), null);
    assert.equal(batteryWarrantyEnd(''), null);
});
