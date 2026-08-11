'use strict';

/**
 * What gets copied from the pending record onto the registration.
 *
 * The app writes the pending document with the same field set as a
 * `registered_products` document, so confirming is mostly a copy. It is an
 * explicit allowlist rather than a spread of the whole document for two
 * reasons: the pending record also carries link machinery (`token`, `status`,
 * `expiresAt`) that has no business on a registration, and an allowlist means a
 * client that writes an extra field cannot put arbitrary keys on the row a
 * transaction later trusts.
 */

/** Registration fields, copied through verbatim when present. */
const PAYLOAD_FIELDS = [
    // Product
    'serialnumber',
    'family',
    'productFamily',
    'producttype',
    'inverterModel',
    'inverterSerial',
    // Customer
    'customerName',
    'customerEmail',
    'customerContact',
    'customerPhone',
    'customerAddress',
    'customerCity',
    'customerState',
    'customerCountry',
    // Battery
    'batterySerial',
    'batteryModel',
    'batteryDetails',
    // Installation
    'installationDate',
    'installationCompany',
    'installationAddress',
    'installationCity',
    'installationState',
    'installationCountry',
    'postalCode',
    'wifiLogger',
    'installerName',
    'installerContact',
    'warrantyEndDate',
];

/**
 * Installer attribution.
 *
 * Kept separate from the payload list only for readability — these are copied
 * too. When an installer registers on a customer's behalf the owner of the row
 * is still the customer (`userId`), and this is the only record of who actually
 * filled the form.
 */
const ATTRIBUTION_FIELDS = [
    'registeredByInstallerId',
    'registeredByInstallerName',
    'registeredByInstallerPhone',
];

/**
 * Fields that must never travel from the pending record to the registration.
 *
 * Listed for the reader's benefit and asserted by the tests; the allowlist
 * above is what actually enforces it.
 */
const NEVER_COPIED = [
    'token',
    'status',
    'expiresAt',
    'createdAt',
    'completedAt',
    'userId',
    'serialDocId',
    'registeredProductId',
];

/**
 * Picks the registration fields out of a pending document.
 *
 * `undefined` is dropped (Firestore rejects it outright); `null`, `''`, `false`
 * and `0` are kept, because "the customer has no email" and "nobody asked about
 * the email" are different facts and the row should be able to say the first.
 */
function payloadFields(pending = {}) {
    const out = {};
    for (const field of [...PAYLOAD_FIELDS, ...ATTRIBUTION_FIELDS]) {
        if (pending[field] !== undefined) out[field] = pending[field];
    }
    return out;
}

module.exports = { payloadFields, PAYLOAD_FIELDS, ATTRIBUTION_FIELDS, NEVER_COPIED };
