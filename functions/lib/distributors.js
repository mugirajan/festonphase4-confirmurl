'use strict';

/**
 * "Add distributor" for a company admin (2026-10-28) — `POST ?action=add-distributor`.
 *
 * Feston staff add distributors straight from the portal, because the
 * Firestore rules let staff create a `users` row with `userType` 2. A company
 * admin may add one too, but the published rules on the test and live
 * projects pre-date that, so their write is refused. This action does the same
 * write with admin credentials, after checking the caller is a company admin,
 * so nothing has to be published for the page to work.
 *
 * The row is exactly what the portal's add-distributor.component.ts writes —
 * a directory entry with no login — plus `addedByCompanyId` and
 * `companyName`, both taken from the caller's own company record: a company
 * admin's distributors belong to their company, whatever the form says.
 */

const { companyAdminFrom } = require('./company-certificates');

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const reply = (status, body) => ({ status, body });

async function addDistributor({ firestore, verifyIdToken, authorization, body, now, logger }) {
    const who = await companyAdminFrom({ firestore, verifyIdToken, authorization, logger, what: 'add-distributor' });
    if (who.error) return who.error;

    const b = body && typeof body === 'object' ? body : {};
    const name = str(b.name);
    const phone = str(b.phone);
    const email = str(b.email);
    const address = str(b.address);
    const landmark = str(b.landmark);
    // Same checks as the portal form, repeated here because the form is not trusted.
    if (name.length < 2) return reply(400, { status: 'invalid', message: "Enter the distributor's name." });
    if (!/^\+?[\d\s-]{10,15}$/.test(phone)) return reply(400, { status: 'invalid', message: 'Enter a valid phone number.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { status: 'invalid', message: 'Enter a valid email, or leave it blank.' });
    if (address.length < 5) return reply(400, { status: 'invalid', message: 'Enter the address.' });

    const [adminSnap, companySnap] = await Promise.all([
        firestore.collection('admins').doc(who.uid).get(),
        firestore.collection('companies').doc(who.companyId).get(),
    ]);
    const createdByName = str((adminSnap.data() || {}).name);
    const companyName = str((companySnap.data() || {}).name) || str((adminSnap.data() || {}).companyName);

    const ref = firestore.collection('users').doc();
    await ref.set({
        uid: ref.id,
        name,
        username: name,
        companyName,
        email,
        phone,
        userType: 2,
        imageUrl: '',
        deleted: false,
        ispremium: false,
        isrequested: false,
        addedInPortal: true,
        addedByCompanyId: who.companyId,
        createdBy: who.uid,
        createdByName,
        createdAt: now(),
        updatedAt: now(),
    });
    await ref.collection('addresses').doc('main').set({
        name: 'Office',
        address,
        landmark,
        show: true,
        createdAt: now(),
        updatedAt: now(),
    });
    if (logger) logger.info('add-distributor: created', { id: ref.id, companyId: who.companyId });
    return reply(200, { status: 'ok', id: ref.id });
}

module.exports = { addDistributor };
