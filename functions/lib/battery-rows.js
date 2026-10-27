'use strict';

/**
 * One registration row per Feston battery (2026-10-27).
 *
 * A hybrid install with an inverter and two Feston batteries is three products,
 * and the customer gets three warranty certificates — one each. The app stages
 * ONE pending record (the inverter's, with the batteries in `batteryDetails`);
 * at confirm, store.js writes the inverter row and then one row per Feston
 * battery built here, the way the app's own buildBatteryRegistrationFields
 * (feston/src/services/registration.ts) builds them: the customer, site,
 * installer and evidence copied from the inverter's row, and the product
 * identity the battery's own. `parentRegistrationId` ties them together.
 *
 * Only FESTON batteries. An other-brand battery has no serial in inventory and
 * is not a Feston product, so Feston cannot issue a warranty for it; those
 * stay in `batteryDetails` on the inverter's row, as before.
 */

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Everything about WHO and WHERE: the same customer, site, engineer and photos. */
const INHERITED_FROM_PARENT = [
    'userId',
    'customerName',
    'customerEmail',
    'customerContact',
    'customerPhone',
    'customerAddress',
    'customerCity',
    'customerState',
    'customerCountry',
    'customerPostalCode',
    'postalCode',
    'selectedAddress',
    'installationDate',
    'installationCompany',
    'installationAddress',
    'installationAddressLine',
    'installationAddressFull',
    'installationCity',
    'installationState',
    'installationCountry',
    'installationPostalCode',
    'installerName',
    'installerContact',
    'wifiLogger',
    'installationPhoto1Url',
    'installationPhoto2Url',
    'addressProofUrl',
    'wifiLoggerPhotoUrl',
    'installationPhotoUrl',
    'appActivatedPhotoUrl',
    'ebBillPhotoUrl',
    'gpsLat',
    'gpsLng',
    'gpsAccuracy',
    'gpsDeviceLat',
    'gpsDeviceLng',
    'gpsPinMovedM',
    'gpsAddress',
    'evidenceHashes',
    'evidenceCapturedAt',
    'registeredByInstallerId',
    'registeredByInstallerName',
    'registeredByInstallerPhone',
    'registeredByInstallerDocId',
    'installerNamedByCustomer',
    'companyId',
    'installTeam',
    'installTeamUids',
    'ownerResolvedAtConfirm',
    'createdAt',
    // The confirmation itself (store.js confirmationMarkers / consentFields):
    // the customer confirmed the whole install, batteries included. Without
    // these a battery row showed "Not confirmed" in the company portal.
    'timestamp',
    'registrationSource',
    'unregistered',
    'isDetailsCorrect',
    'customerConfirmed',
    'customerConfirmedAt',
    'marketingConsent',
    'marketingConsentAt',
    'acceptedTerms',
    'acceptedDataForTraining',
    'dataUsageConsent',
    'confirmedAt',
    'confirmationMethod',
    'consentMethod',
    'acceptedMarketing',
    'consentRecordedAt',
    'verifiedPhone',
];

/** A Feston battery carries 5 years (the app's data/warranty.ts). */
const BATTERY_WARRANTY_YEARS = 5;

/**
 * The Feston batteries on a pending record, normalised to
 * `{ serial, model, subtype, capacityKw }`. The app writes objects with `sn`;
 * the web wrote `{ sn, model }`; older rows held bare serial strings.
 */
function festonBatteriesOf(pending) {
    const b = pending && pending.batteryDetails && typeof pending.batteryDetails === 'object' ? pending.batteryDetails : null;
    if (!b || str(b.brand) !== 'feston' || !Array.isArray(b.festonBatteries)) return [];
    const out = [];
    for (const x of b.festonBatteries) {
        const serial = typeof x === 'string' ? str(x) : str((x || {}).sn) || str((x || {}).serial);
        if (!serial) continue;
        const kw = Number(typeof x === 'object' && x ? x.capacityKw : NaN);
        out.push({
            serial,
            model: typeof x === 'object' && x ? str(x.model) : '',
            subtype: typeof x === 'object' && x ? str(x.subtype) : '',
            capacityKw: Number.isFinite(kw) && kw > 0 ? kw : null,
        });
    }
    return out;
}

/** installationDate + 5 years, as a Date; null when the date does not parse. */
function batteryWarrantyEnd(installationDate) {
    const raw = installationDate && typeof installationDate.toDate === 'function' ? installationDate.toDate() : installationDate;
    const d = raw instanceof Date ? new Date(raw.getTime()) : typeof raw === 'string' && raw ? new Date(raw) : null;
    if (!d || Number.isNaN(d.getTime())) return null;
    d.setFullYear(d.getFullYear() + BATTERY_WARRANTY_YEARS);
    return d;
}

/**
 * The battery's own registration row.
 *
 * `inverterRow` is the inverter's row as written (so everything it inherits
 * is exactly what the customer confirmed); `toTimestamp` turns a Date into
 * the Firestore value (injected so the tests need no Admin SDK).
 */
function batteryRow(inverterRow, entry, { parentRegistrationId, toTimestamp }) {
    const inherited = {};
    for (const k of INHERITED_FROM_PARENT) {
        if (inverterRow[k] !== undefined) inherited[k] = inverterRow[k];
    }
    const end = batteryWarrantyEnd(inverterRow.installationDate);
    return {
        ...inherited,

        // --- identity: a battery, not the inverter ---
        serialnumber: entry.serial,
        Serialnumber: entry.serial,
        productFamily: 'batteries',
        family: 'batteries',
        producttype: 'BATTERIES',
        inverterModel: entry.model,
        inverterSerial: entry.serial,
        submodel: entry.subtype,
        ...(entry.capacityKw != null ? { kilowatt: entry.capacityKw } : {}),
        // Storage is kWh, not generation: never summed into "kW commissioned"
        // or the Solar Super Hero impact. Null, as on an inverter with no
        // inventory capacity, so readers see "not known" rather than 0.
        capacityKw: null,

        // The inverter's battery mirrors point at the FIRST battery of the
        // system; this row is about itself.
        batterySerial: entry.serial,
        batteryModel: entry.model,
        batteryDetails: {
            purchased: true,
            brand: 'feston',
            festonBatteries: [{ sn: entry.serial, model: entry.model, subtype: entry.subtype, capacityKw: entry.capacityKw != null ? String(entry.capacityKw) : '' }],
        },

        // --- warranty: 5 years from the same installation date ---
        warrantyYears: BATTERY_WARRANTY_YEARS,
        ...(end ? { warrantyEndDate: toTimestamp(end) } : {}),

        // --- the inverter this battery was installed with ---
        parentRegistrationId,
    };
}

module.exports = { INHERITED_FROM_PARENT, BATTERY_WARRANTY_YEARS, festonBatteriesOf, batteryWarrantyEnd, batteryRow };
