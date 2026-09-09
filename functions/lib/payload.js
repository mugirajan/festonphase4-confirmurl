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
    // These sit on the pending record and were simply never listed, so they
    // never reached the registration. `Phase` and `capacity` are printed on the
    // warranty certificate; the media URLs are the evidence of the install.
    'Phase',
    'capacity',
    'submodel',
    'invoiceUrl',
    'installationPhoto1Url',
    'installationPhoto2Url',
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

/**
 * The web portal's field names for the same facts.
 *
 * `registered_products` has TWO field conventions, and both are live:
 *
 *   web portal / certificate   Serialnumber · name · type · capacity · Phase
 *   mobile app / this function serialnumber · inverterModel · producttype
 *
 * The header above says the pending record carries "the same field set as a
 * `registered_products` document". That is true of the MOBILE shape and false
 * of the web one, and the gap is not cosmetic: the portal's certificate
 * generator looks a registration up with
 * `where('Serialnumber', '==', serial)` — capital S — so **every registration
 * completed through the app was invisible to it**. All 25 sampled existing rows
 * carry `Serialnumber`; the ones this function wrote carried only
 * `serialnumber`, and produced "No registered product found" for a row sitting
 * right there in the collection.
 *
 * Both conventions are written rather than picking a winner. Renaming would
 * break whichever half of the estate reads the other name, and neither half is
 * ours to migrate from here. Derived, never asked of the caller, so the app
 * needs no release for this.
 *
 * Only fields with a real value are emitted — an empty `Serialnumber` would be
 * worse than none, because a query for '' would match it.
 */
function webCompatFields(pending = {}) {
    const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
    const out = {};

    // The lookup key the portal and the certificate generator both query.
    const serial = str(pending.serialnumber) || str(pending.inverterSerial);
    if (serial) out.Serialnumber = serial;

    // The portal calls the model "name" and the family "type".
    const model = str(pending.inverterModel) || str(pending.modelnumber);
    if (model) out.name = model;

    const type = str(pending.producttype) || str(pending.family) || str(pending.productFamily);
    if (type) out.type = type;

    const family = str(pending.productFamily) || str(pending.family);
    if (family) out.selectedProductType = family;

    // The customer's address, under the name the portal reads it by.
    const address = str(pending.customerAddress) || str(pending.selectedAddress);
    if (address) out.selectedAddress = address;

    return out;
}

module.exports = {
    payloadFields,
    webCompatFields,
    PAYLOAD_FIELDS,
    ATTRIBUTION_FIELDS,
    NEVER_COPIED,
};
