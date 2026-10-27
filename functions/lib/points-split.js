'use strict';

/**
 * Points for an install more than one engineer worked on (2026-10-22).
 *
 * "Save & hand off" lets several engineers of a company carry one install
 * between them; until now the whole install award went to whoever submitted.
 * Now, when the confirmed registration's `installTeam` names two or more
 * engineers, the install's base points (capacity × rate) are HELD in
 * `points_splits/{registrationId}` instead, and the company admin divides
 * exactly that total between the engineers in the portal — one Submit per
 * engineer. Feston pays the same total as before; only who receives it moves.
 *
 * Unchanged on a multi-engineer install: the completer's install count, and
 * the automatic bonuses (48 h, email verified, Wi-Fi logger, app activated, EB
 * bill), which stay with the completer. A single-engineer install is paid at
 * confirm exactly as before.
 *
 * Each credit leaves a notification in `installer_notifications` for the
 * engineer, which the app lists under the bell on the installer home screen.
 *
 * The portal and the app reach all of this through the confirm function's
 * `?action=` endpoints with an ID token, so no Firestore rule had to open:
 * company admins still cannot write `installers.points` or the ledger directly.
 */

const SPLITS_COLLECTION = 'points_splits';
const NOTIFICATIONS_COLLECTION = 'installer_notifications';
/** The cap on one credit, matching the portal's correction limit. */
const MAX_POINTS = 100000;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const reply = (status, body) => ({ status, body });

const ROLE_LABELS = {
    started: 'Started',
    worked: 'Worked on',
    completed: 'Completed',
    'started-completed': 'Started and completed',
};

/**
 * The distinct engineers on a pending registration's install team, in the
 * order they joined. Two or more means the install is split; fewer is a
 * normal single-engineer install and returns [].
 */
function splitTeam(pending) {
    const raw = Array.isArray(pending && pending.installTeam) ? pending.installTeam : [];
    const seen = new Set();
    const team = [];
    for (const m of raw) {
        const uid = str(m && m.uid);
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        team.push({
            uid,
            name: str(m.name),
            contact: str(m.contact),
            company: str(m.company),
            role: ROLE_LABELS[str(m.role)] ? str(m.role) : 'worked',
            firstAt: str(m.firstAt),
            lastAt: str(m.lastAt),
        });
        if (team.length >= 10) break;
    }
    return team.length >= 2 ? team : [];
}

/** The `points_splits/{registrationId}` record written at confirm. */
function splitRecord({ pending, team, pool, awardBasis, capacityKw, companyId, registrationId, completerUid, now }) {
    return {
        registrationId,
        companyId,
        status: 'pending',
        pool,
        remaining: pool,
        awardBasis,
        capacityKw: capacityKw == null ? null : capacityKw,
        completerUid,
        team,
        awards: {},
        customer: {
            name: str(pending.customerName),
            phone: str(pending.customerContact) || str(pending.customerPhone),
            city: str(pending.installationCity) || str(pending.customerCity),
            address: str(pending.installationAddress) || str(pending.customerAddress),
        },
        product: {
            serialnumber: str(pending.serialnumber),
            family: str(pending.productFamily),
            model: str(pending.inverterModel) || str(pending.model),
        },
        installationDate: str(pending.installationDate),
        createdAt: now,
    };
}

/* ── Callers ──────────────────────────────────────────────────────────────── */

/** The signed-in caller's uid, or null. */
async function callerUid({ verifyIdToken, authorization, logger }) {
    const bearer = /^Bearer\s+(.+)$/i.exec(str(authorization));
    if (!bearer) return null;
    try {
        return (await verifyIdToken(bearer[1])).uid || null;
    } catch (error) {
        if (logger) logger.warn('points-split: bad token', { error: String(error && error.message) });
        return null;
    }
}

/** A company admin and their company, or null. */
async function companyAdmin(firestore, uid) {
    const snap = await firestore.collection('admins').doc(uid).get();
    if (!snap.exists) return null;
    const d = snap.data() || {};
    if (str(d.role).toLowerCase() !== 'company-admin' || !str(d.companyId)) return null;
    return { uid, name: str(d.name) || str(d.email) || 'Company admin', companyId: str(d.companyId) };
}

/** An engineer's `installers` row, keyed either by uid or by an auto-id with a `uid` field. */
async function installerRow(firestore, tx, uid) {
    const direct = firestore.collection('installers').doc(uid);
    const snap = await tx.get(direct);
    if (snap.exists) return snap;
    const byUid = await tx.get(firestore.collection('installers').where('uid', '==', uid).limit(1));
    return byUid.empty ? null : byUid.docs[0];
}

/* ── Company admin: list and credit ───────────────────────────────────────── */

/**
 * The company's installs still waiting to be split, oldest first, with the
 * active points rules the admin can pick an amount from.
 */
async function listPendingSplits({ firestore, verifyIdToken, authorization, logger }) {
    const uid = await callerUid({ verifyIdToken, authorization, logger });
    if (!uid) return reply(401, { status: 'unauthenticated' });
    const admin = await companyAdmin(firestore, uid);
    if (!admin) return reply(403, { status: 'forbidden' });

    const snap = await firestore
        .collection(SPLITS_COLLECTION)
        .where('companyId', '==', admin.companyId)
        .where('status', '==', 'pending')
        .limit(50)
        .get();
    const splits = snap.docs
        .map((d) => {
            const r = d.data() || {};
            const created = r.createdAt && typeof r.createdAt.toMillis === 'function' ? r.createdAt.toMillis() : 0;
            return { id: d.id, ...r, createdAt: created };
        })
        .sort((a, b) => a.createdAt - b.createdAt);

    const rulesSnap = await firestore.collection('points_config').get();
    const rules = rulesSnap.docs
        .map((d) => ({ key: d.id, ...(d.data() || {}) }))
        .filter((r) => r.active !== false && Number(r.points) > 0)
        .map((r) => ({ key: r.key, label: str(r.label) || r.key, points: Math.round(Number(r.points)) }))
        .sort((a, b) => a.points - b.points);

    return reply(200, { status: 'ok', splits, rules });
}

/**
 * Credits one engineer their share of one held install.
 *
 * body: { registrationId, installerUid, points }
 *
 * In one transaction: the engineer's balance, a ledger row, the split's
 * running remainder, and the engineer's notification. Refused when the amount
 * is more than what is left, or the engineer already has their share.
 */
async function awardSplit({ firestore, verifyIdToken, authorization, body, now, increment, logger }) {
    const uid = await callerUid({ verifyIdToken, authorization, logger });
    if (!uid) return reply(401, { status: 'unauthenticated' });
    const admin = await companyAdmin(firestore, uid);
    if (!admin) return reply(403, { status: 'forbidden' });

    const b = body && typeof body === 'object' ? body : {};
    const registrationId = str(b.registrationId);
    const installerUid = str(b.installerUid);
    const points = Number(b.points);
    if (!registrationId || !installerUid) return reply(400, { status: 'bad-request', message: 'Missing install or engineer.' });
    if (!Number.isInteger(points) || points <= 0 || points > MAX_POINTS) {
        return reply(400, { status: 'bad-points', message: 'Enter a whole number of points above zero.' });
    }

    const splitRef = firestore.collection(SPLITS_COLLECTION).doc(registrationId);

    return firestore.runTransaction(async (tx) => {
        const splitSnap = await tx.get(splitRef);
        if (!splitSnap.exists) return reply(404, { status: 'not-found', message: 'This install is no longer waiting.' });
        const split = splitSnap.data() || {};
        if (split.companyId !== admin.companyId) return reply(403, { status: 'forbidden' });
        if (split.status !== 'pending') return reply(409, { status: 'done', message: 'All points for this install are already given.' });

        const member = (split.team || []).find((m) => m.uid === installerUid);
        if (!member) return reply(400, { status: 'not-on-team', message: 'This engineer did not work on this install.' });
        // An engineer may be given more than once while points are left
        // (2026-10-22): with one payment each, an install whose engineers had
        // all been paid but not the whole total could never be finished. The
        // total is still capped by `remaining`, so the install never pays more.
        const before = Number(split.awards && split.awards[installerUid] && split.awards[installerUid].points) || 0;
        const remaining = Number(split.remaining) || 0;
        if (points > remaining) {
            return reply(400, { status: 'over', message: `Only ${remaining} points are left to give for this install.` });
        }

        const installerSnap = await installerRow(firestore, tx, installerUid);
        if (!installerSnap) return reply(404, { status: 'no-installer', message: 'This engineer has no points account.' });

        const left = remaining - points;
        const product = split.product || {};
        const customer = split.customer || {};
        const phase = ROLE_LABELS[member.role] || 'Worked on';

        tx.update(installerSnap.ref, {
            points: increment(points),
            pointsUpdatedAt: now(),
        });
        tx.set(firestore.collection('installer_points').doc(), {
            installerId: installerSnap.id,
            installerUid,
            installerName: member.name,
            companyId: split.companyId,
            // The install's own award, shared: same action as a single-engineer
            // install so histories and dashboards read it the same way.
            action: 'complete_registration',
            points,
            type: 'credit',
            awardBasis: 'split',
            capacityKw: split.capacityKw == null ? null : split.capacityKw,
            registrationId,
            // Named here too (2026-10-26): a teammate's install is not in the
            // engineer's own registration list and the rules do not let them
            // read it, so the app's points history takes the name from the row.
            serialnumber: str(product.serialnumber),
            customerName: str(customer.name),
            splitPhase: member.role,
            createdAt: now(),
            createdBy: admin.uid,
            createdByName: admin.name,
        });
        tx.update(splitRef, {
            // The engineer's running total for this install.
            [`awards.${installerUid}`]: { points: before + points, at: now(), by: admin.uid, byName: admin.name },
            remaining: left,
            ...(left === 0 ? { status: 'done', doneAt: now() } : {}),
            updatedAt: now(),
        });
        tx.set(firestore.collection(NOTIFICATIONS_COLLECTION).doc(), {
            installerUid,
            kind: 'points-split',
            title: `${points} points credited`,
            message:
                `You received ${points} points for ${customer.name || 'the customer'}'s install` +
                `${product.serialnumber ? ` (SN ${product.serialnumber})` : ''} — ${phase}. ` +
                `Given by ${admin.name}.`,
            points,
            registrationId,
            read: false,
            createdAt: now(),
        });

        return reply(200, { status: 'ok', remaining: left, done: left === 0 });
    });
}

/**
 * Every Submit the company admin made, newest first — one row per credit, so a
 * top-up shows as its own line — for the portal's Points split history.
 *
 * Read from the points ledger (`installer_points`, `awardBasis: 'split'`),
 * which is the record of what was actually paid, joined to the split for the
 * customer, serial and how much of the install is given.
 */
async function listSplitHistory({ firestore, verifyIdToken, authorization, logger }) {
    const uid = await callerUid({ verifyIdToken, authorization, logger });
    if (!uid) return reply(401, { status: 'unauthenticated' });
    const admin = await companyAdmin(firestore, uid);
    if (!admin) return reply(403, { status: 'forbidden' });

    const millis = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);
    const [ledger, splits] = await Promise.all([
        firestore
            .collection('installer_points')
            .where('companyId', '==', admin.companyId)
            .where('awardBasis', '==', 'split')
            .limit(500)
            .get(),
        firestore.collection(SPLITS_COLLECTION).where('companyId', '==', admin.companyId).limit(500).get(),
    ]);
    const byId = new Map(splits.docs.map((d) => [d.id, d.data() || {}]));
    const rows = ledger.docs.map((d) => {
        const r = d.data() || {};
        const s = byId.get(str(r.registrationId)) || {};
        return {
            registrationId: str(r.registrationId),
            installerUid: str(r.installerId),
            installerName: str(r.installerName),
            phase: ROLE_LABELS[str(r.splitPhase)] || 'Worked on',
            points: Number(r.points) || 0,
            givenBy: str(r.createdByName),
            givenAt: millis(r.createdAt),
            customerName: str((s.customer || {}).name),
            serialnumber: str((s.product || {}).serialnumber),
            pool: Number(s.pool) || 0,
            splitStatus: str(s.status),
        };
    });
    rows.sort((a, b) => b.givenAt - a.givenAt);
    return reply(200, { status: 'ok', rows });
}

/* ── Engineer: notifications ─────────────────────────────────────────────── */

/** The caller's notifications, newest first (sorted here: no composite index needed). */
async function listNotifications({ firestore, verifyIdToken, authorization, logger }) {
    const uid = await callerUid({ verifyIdToken, authorization, logger });
    if (!uid) return reply(401, { status: 'unauthenticated' });
    const snap = await firestore.collection(NOTIFICATIONS_COLLECTION).where('installerUid', '==', uid).limit(100).get();
    const items = snap.docs
        .map((d) => {
            const r = d.data() || {};
            const created = r.createdAt && typeof r.createdAt.toMillis === 'function' ? r.createdAt.toMillis() : 0;
            return {
                id: d.id,
                kind: str(r.kind),
                title: str(r.title),
                message: str(r.message),
                points: Number(r.points) || 0,
                registrationId: str(r.registrationId),
                read: r.read === true,
                createdAt: created,
            };
        })
        .sort((a, b) => b.createdAt - a.createdAt);
    return reply(200, { status: 'ok', items, unread: items.filter((i) => !i.read).length });
}

/** Marks the caller's notifications read: body.ids, or all of them when absent. */
async function markNotificationsRead({ firestore, verifyIdToken, authorization, body, logger }) {
    const uid = await callerUid({ verifyIdToken, authorization, logger });
    if (!uid) return reply(401, { status: 'unauthenticated' });
    const ids = Array.isArray(body && body.ids) ? body.ids.map(str).filter(Boolean).slice(0, 100) : null;
    const snap = await firestore.collection(NOTIFICATIONS_COLLECTION).where('installerUid', '==', uid).limit(100).get();
    const batch = firestore.batch();
    let n = 0;
    for (const d of snap.docs) {
        if ((d.data() || {}).read === true) continue;
        if (ids && !ids.includes(d.id)) continue;
        batch.update(d.ref, { read: true });
        n += 1;
    }
    if (n) await batch.commit();
    return reply(200, { status: 'ok', marked: n });
}

module.exports = {
    SPLITS_COLLECTION,
    NOTIFICATIONS_COLLECTION,
    ROLE_LABELS,
    splitTeam,
    splitRecord,
    listPendingSplits,
    listSplitHistory,
    awardSplit,
    listNotifications,
    markNotificationsRead,
};
