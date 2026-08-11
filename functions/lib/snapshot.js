'use strict';

/**
 * The details snapshot — what the customer is asked to check.
 *
 * The pending record the app writes is itself the snapshot: it holds the same
 * field set as a `registered_products` document, frozen at the moment the link
 * was issued, and confirming copies it forward. So the customer is always
 * agreeing to exactly the fields that become the registration — the page and
 * the write read one document, and cannot disagree about what was approved.
 */

const {
    asString,
    familyLongName,
    phaseDisplay,
    capacityDisplay,
    toDateString,
    dateDisplay,
} = require('./format');

/** Comparison key for "is this address part already in the line?". */
const addressKey = (value) => asString(value).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Joins an address line with its city / state / country parts.
 *
 * The two writers disagree here too: the portal wizard stores one already
 * composed line, the mobile app stores the street line and the city, state and
 * country as separate fields — and its own review screen shows them joined. A
 * part is appended only when it is not already in the line, so a composed
 * address does not come back as "Chennai, Chennai, Tamil Nadu, Tamil Nadu".
 */
function composeAddress(line, ...parts) {
    const out = [];
    let seen = addressKey(line);

    if (asString(line)) out.push(asString(line));

    for (const part of parts) {
        const value = asString(part);
        if (!value) continue;
        const key = addressKey(value);
        if (!key || seen.includes(key)) continue;
        out.push(value);
        seen += key;
    }

    return out.join(', ');
}

/**
 * A model name, or '' for the "NA" the certificate path writes for products
 * that have no inverter. "Model: NA" on a page a customer is asked to check
 * reads as a mistake; an omitted row reads as "not applicable", which it is.
 */
function modelName(value) {
    const model = asString(value);
    return /^n\/?a$/i.test(model) ? '' : model;
}

/**
 * Builds a snapshot from a `pending_registrations` or `registered_products`
 * document — they carry the same field set, which is what makes confirming a
 * copy rather than a translation.
 *
 * Two writers fill these collections with two different field sets, so every
 * field below reads the portal wizard's name and the mobile app's name:
 *
 *   wizard                    mobile app
 *   Serialnumber              serialnumber / inverterSerial
 *   modelnumber, name         inverterModel
 *   productFamily             productFamily, family
 *   installationAddressFull   installationAddress + City/State/Country
 *   installationPostalCode    postalCode
 *   warrantyEndDate (string)  warrantyEndDate (Timestamp)
 *
 * Existing casing quirks (`Serialnumber`, `Phase`) are read as stored, not
 * renamed — this has to keep working against rows already written.
 */
function buildDetailsFromRegistration(data = {}) {
    return {
        customer: {
            name: asString(data.customerName),
            // customerPhone is the bare 10-digit number; customerContact is the
            // same number in E.164. Prefer the plain one — it is what the
            // customer recognises as theirs.
            phone: asString(data.customerPhone) || asString(data.customerContact),
            email: asString(data.customerEmail),
            address: composeAddress(
                asString(data.customerAddress) || asString(data.selectedAddress),
                data.customerCity,
                data.customerState,
                data.customerCountry,
            ),
        },
        product: {
            serialNumber:
                asString(data.Serialnumber) ||
                asString(data.serialnumber) ||
                asString(data.inverterSerial),
            productFamily:
                asString(data.productFamily) || asString(data.family) || asString(data.producttype),
            model: modelName(data.inverterModel) || modelName(data.modelnumber) || modelName(data.name),
            capacity: asString(data.capacity) || asString(data.kilowatt),
            phase: asString(data.Phase) || asString(data.phase),
            submodel: asString(data.submodel),
        },
        installation: {
            installerName: asString(data.installerName),
            installerContact: asString(data.installerContact),
            company: asString(data.installationCompany),
            installationDate: toDateString(data.installationDate),
            address: composeAddress(
                asString(data.installationAddressFull) ||
                    asString(data.installationAddress) ||
                    asString(data.installationAddressLine),
                data.installationCity,
                data.installationState,
                data.installationCountry,
            ),
            postalCode: asString(data.installationPostalCode) || asString(data.postalCode),
            wifiLogger: asString(data.wifiLogger),
            warrantyEndDate: toDateString(data.warrantyEndDate),
        },
        batteryDetails: data.batteryDetails || flatBattery(data),
    };
}

/**
 * A battery recorded as two flat fields rather than a `batteryDetails` object.
 *
 * `batterySerial` / `batteryModel` are on the app→web handoff field list as
 * plain strings, so a record can describe its battery that way instead of with
 * the nested object the wizard writes. Brand is assumed Feston: these fields
 * only ever carry a Feston serial, and an other-brand battery is written as the
 * nested object with its own brand on it.
 */
function flatBattery(data = {}) {
    const sn = asString(data.batterySerial);
    const model = asString(data.batteryModel);
    if (!sn && !model) return null;
    return { purchased: true, brand: 'feston', festonBatteries: [{ sn, model }] };
}

/**
 * Accepts a caller-supplied details object and returns it in the canonical
 * shape, dropping anything not recognised.
 *
 * Callers that mint a link before the registration document exists send their
 * own details; this stops an arbitrary blob from being stored and later
 * rendered. Unknown keys are discarded rather than rejected, so a caller
 * sending a superset does not get an error it cannot act on.
 */
function normaliseDetails(details = {}) {
    const customer = details.customer || {};
    const product = details.product || {};
    const installation = details.installation || {};
    return {
        customer: {
            name: asString(customer.name),
            phone: asString(customer.phone),
            email: asString(customer.email),
            address: asString(customer.address),
        },
        product: {
            serialNumber: asString(product.serialNumber),
            productFamily: asString(product.productFamily),
            model: asString(product.model),
            capacity: asString(product.capacity),
            phase: asString(product.phase),
            submodel: asString(product.submodel),
        },
        installation: {
            installerName: asString(installation.installerName),
            installerContact: asString(installation.installerContact),
            company: asString(installation.company),
            installationDate: toDateString(installation.installationDate),
            address: asString(installation.address),
            postalCode: asString(installation.postalCode),
            wifiLogger: asString(installation.wifiLogger),
            warrantyEndDate: toDateString(installation.warrantyEndDate),
        },
        batteryDetails: details.batteryDetails || null,
    };
}

/**
 * Overlays a caller-supplied snapshot onto one built from the registration.
 *
 * Only non-empty supplied fields win, so a caller that knows one thing the
 * document does not — capacity and phase are the real case; they are on the
 * app's review screen but are never written to `registered_products` — can send
 * just those two without having to restate the whole registration.
 *
 * `batteryDetails` is replaced wholesale rather than merged: it is a record of
 * what was bought, and half of one from each source would describe neither.
 */
function mergeDetails(base, override) {
    if (!override) return base;
    if (!base) return override;

    const group = (name) => {
        const merged = { ...(base[name] || {}) };
        for (const [key, value] of Object.entries(override[name] || {})) {
            if (asString(value)) merged[key] = value;
        }
        return merged;
    };

    return {
        customer: group('customer'),
        product: group('product'),
        installation: group('installation'),
        batteryDetails: override.batteryDetails || base.batteryDetails || null,
    };
}

/** A snapshot with nothing in it would give the customer nothing to acknowledge. */
function hasAnyDetail(details) {
    if (!details) return false;
    const groups = [details.customer, details.product, details.installation];
    return groups.some((group) => group && Object.values(group).some((v) => asString(v).length > 0));
}

/** Battery lines for the snapshot, or [] when the registration recorded none. */
function batteryLines(batteryDetails) {
    if (!batteryDetails || typeof batteryDetails !== 'object') return [];
    if (batteryDetails.purchased === false) return ['No batteries purchased'];

    if (batteryDetails.brand === 'feston') {
        const list = Array.isArray(batteryDetails.festonBatteries) ? batteryDetails.festonBatteries : [];
        return list
            .map((b) => {
                // The wizard stores { sn, model }; the mobile app stores the
                // serial on its own as a plain string.
                if (typeof b === 'string') return asString(b);
                const sn = asString(b && b.sn) || asString(b && b.serial);
                const model = asString(b && b.model);
                if (!sn && !model) return '';
                return sn && model ? `${sn} · ${model}` : sn || model;
            })
            .filter(Boolean);
    }

    if (batteryDetails.brand === 'other') {
        const list = Array.isArray(batteryDetails.otherBatteries) ? batteryDetails.otherBatteries : [];
        return list
            .map((b) => {
                if (typeof b === 'string') return asString(b);
                const name = [asString(b && b.brand), asString(b && b.model)].filter(Boolean).join(' ');
                const serial = asString(b && b.serial);
                if (name && serial) return `${name} · ${serial}`;
                return name || serial;
            })
            .filter(Boolean);
    }

    return [];
}

/**
 * Turns a snapshot into the sections the page renders.
 *
 * Empty fields are dropped rather than shown as "—": a confirmation screen
 * should read as a short, checkable list of facts, and a column of dashes
 * invites the customer to skim past the ones that matter.
 */
function toDisplaySections(details) {
    const safe = details || {};
    const customer = safe.customer || {};
    const product = safe.product || {};
    const installation = safe.installation || {};

    const section = (title, rows) => ({
        title,
        rows: rows.filter((row) => asString(row.value).length > 0),
    });

    const sections = [
        section('Your details', [
            { label: 'Name', value: customer.name },
            { label: 'Phone', value: customer.phone },
            { label: 'Email', value: customer.email },
            { label: 'Address', value: customer.address, wide: true },
        ]),
        section('Product', [
            { label: 'Product', value: familyLongName(product.productFamily) },
            { label: 'Serial Number', value: product.serialNumber, mono: true },
            { label: 'Model', value: product.model },
            { label: 'Capacity', value: capacityDisplay(product.capacity) },
            { label: 'Phase', value: phaseDisplay(product.phase) },
            { label: 'Subcategory', value: product.submodel },
        ]),
        section('Installation', [
            { label: 'Installer Name', value: installation.installerName },
            { label: 'Installer Contact', value: installation.installerContact },
            { label: 'Company', value: installation.company },
            { label: 'Installation Date', value: dateDisplay(installation.installationDate) },
            { label: 'Installation Address', value: installation.address, wide: true },
            { label: 'Postal Code', value: installation.postalCode },
            { label: 'Wifi Logger No', value: installation.wifiLogger },
            { label: 'Warranty Valid Till', value: dateDisplay(installation.warrantyEndDate) },
        ]),
    ];

    const batteries = batteryLines(safe.batteryDetails);
    if (batteries.length) {
        sections.push(
            section(
                'Batteries',
                batteries.map((line, index) => ({
                    label: batteries.length > 1 ? `Battery ${index + 1}` : 'Battery',
                    value: line,
                })),
            ),
        );
    }

    return sections.filter((s) => s.rows.length > 0);
}

module.exports = {
    buildDetailsFromRegistration,
    normaliseDetails,
    mergeDetails,
    hasAnyDetail,
    batteryLines,
    toDisplaySections,
};
