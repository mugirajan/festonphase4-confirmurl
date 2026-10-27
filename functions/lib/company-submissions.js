'use strict';

/**
 * Companies typed in by hand at registration (2026-10-27).
 *
 * A customer whose installer is not in Feston's directory types the company
 * name, the engineer's name and phone on the Installation step (an engineer
 * choosing "Other" does the same). That registration completes like any
 * other — the customer's product is never held up by who installed it — but
 * the company is NOT a Feston installer company until Feston says so.
 *
 * So at confirm the typed details are recorded here, in
 * `company_submissions`, one record per company name + phone, listing every
 * registration that named it. The portal's Installer Company page shows the
 * pending ones; Feston approves one (creating the company, which then owns
 * those installs) or rejects it. Either way the registrations stand.
 *
 * Nothing is recorded when the registration already carries a company
 * (`companyId`, from the engineer's own installer record) or when a company
 * of exactly that name already exists.
 */

const { REGISTRATIONS_COLLECTION } = require('./config');

const SUBMISSIONS_COLLECTION = 'company_submissions';
const COMPANIES_COLLECTION = 'companies';

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const last10 = (v) => str(v).replace(/\D/g, '').slice(-10);

/** "Sun Solars Pvt. Ltd" → "sunsolarspvtltd": the same company however it was typed. */
function nameKey(name) {
    return str(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** One record per company name + engineer phone. */
function submissionId(name, phone) {
    const key = nameKey(name) || 'unnamed';
    const p = last10(phone) || 'nophone';
    return `${key}__${p}`.slice(0, 120);
}

const uniq = (xs) => Array.from(new Set(xs.filter(Boolean)));

/**
 * Records (or extends) the submission for a just-completed registration.
 * Best effort by design: the caller never fails a registration over this.
 *
 * `row` is the registration as written; `source` is 'customer' or 'installer'.
 * Resolves `{ recorded, reason?, id? }`.
 */
async function recordCompanySubmission(firestore, { registrationId, row, batteryRegistrationIds = [], source = 'customer', now }) {
    const name = str(row && row.installationCompany);
    if (!name) return { recorded: false, reason: 'no-company-name' };
    if (str(row.companyId)) return { recorded: false, reason: 'has-company', companyId: str(row.companyId) };

    // A company Feston already knows by this exact name needs no review.
    const known = await firestore.collection(COMPANIES_COLLECTION).where('name', '==', name).limit(1).get();
    if (!known.empty) return { recorded: false, reason: 'known-company', companyId: known.docs[0].id };

    const installerPhone = str(row.installerContact);
    const id = submissionId(name, installerPhone);
    const ref = firestore.collection(SUBMISSIONS_COLLECTION).doc(id);
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() || {} : null;

    const registrationIds = uniq([...(existing ? existing.registrationIds || [] : []), registrationId, ...batteryRegistrationIds]);
    const serialnumbers = uniq([...(existing ? existing.serialnumbers || [] : []), str(row.serialnumber) || str(row.Serialnumber)]);
    const stamp = now || new Date();

    if (!existing) {
        await ref.set({
            name,
            nameKey: nameKey(name),
            installerName: str(row.installerName),
            installerPhone,
            customerName: str(row.customerName),
            customerPhone: str(row.customerContact) || str(row.customerPhone),
            source,
            status: 'pending',
            registrationIds,
            serialnumbers,
            registrationCount: registrationIds.length,
            createdAt: stamp,
            updatedAt: stamp,
            lastRegistrationAt: stamp,
        });
        return { recorded: true, id, created: true };
    }

    // Seen before: add this registration. A rejected company that keeps
    // turning up stays rejected but shows the new count, so Feston can
    // reconsider with the facts in front of them.
    await ref.set(
        {
            registrationIds,
            serialnumbers,
            registrationCount: registrationIds.length,
            lastRegistrationAt: stamp,
            updatedAt: stamp,
            ...(str(existing.installerName) ? {} : { installerName: str(row.installerName) }),
        },
        { merge: true },
    );
    return { recorded: true, id, created: false };
}

module.exports = { SUBMISSIONS_COLLECTION, REGISTRATIONS_COLLECTION, nameKey, submissionId, recordCompanySubmission };
