'use strict';

/**
 * The installer's social-post link (2026-11-19): it must be on the platform the
 * reward is for, and one link is accepted once.
 *
 *   - An Instagram post link must be on instagram.com, a Facebook one on
 *     facebook.com, a LinkedIn one on linkedin.com (and each platform's own
 *     short-link domain). Anything else is refused.
 *   - A link already filed with another photo — by anyone, on any install — is
 *     refused. Two spellings of one post (www. or not, a tracking `?igsh=…`
 *     on the end, a trailing slash) count as the same link.
 *
 * `POST ?action=check-post-link` lets the app ask before it uploads the photo;
 * `awardPhotoClaim` (lib/claim-award.js) applies the same test again inside its
 * transaction, which is the one that counts.
 *
 * `post_link_register/{hash of the link}` holds one row per accepted link. It
 * is written only here and in the award, with admin credentials.
 */

const crypto = require('node:crypto');
const { findInstallerByUid } = require('./installer-lookup');

const REGISTER_COLLECTION = 'post_link_register';

/** Rule key → the platform's name and the domains its post links live on. */
const PLATFORMS = {
    instagram_post: { name: 'Instagram', hosts: ['instagram.com', 'instagr.am'] },
    facebook_post: { name: 'Facebook', hosts: ['facebook.com', 'fb.com', 'fb.watch', 'fb.me'] },
    linkedin_post: { name: 'LinkedIn', hosts: ['linkedin.com', 'lnkd.in'] },
};

/** Facebook addresses some posts by query (`permalink.php?story_fbid=…&id=…`); these are the ids. */
const FACEBOOK_ID_PARAMS = ['fbid', 'id', 'story_fbid', 'v'];

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const reply = (status, body) => ({ status, body });

/** Does this kind of photo carry a post link at all? */
const takesPostLink = (kind) => Object.prototype.hasOwnProperty.call(PLATFORMS, kind);

/**
 * Check one pasted link for one kind.
 * @returns {{ok: true, link: string, key: string, id: string} | {ok: false, status: string, message: string}}
 */
function validatePostLink(kind, raw) {
    const platform = PLATFORMS[kind];
    const link = str(raw);
    let url = null;
    try {
        url = new URL(link);
    } catch {
        url = null;
    }
    if (!platform || !url || !/^https?:$/.test(url.protocol) || link.length > 500) {
        return { ok: false, status: 'bad-link', message: 'That is not a web link. Paste the full link to your post.' };
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const base = platform.hosts.find((h) => host === h || host.endsWith(`.${h}`));
    if (!base) {
        return {
            ok: false,
            status: 'wrong-platform',
            message: `This must be a link to your ${platform.name} post, on ${platform.hosts[0]}.`,
        };
    }

    // One post, one key: the platform's domain without www./m./country prefix,
    // the path without a trailing slash, and no tracking query. The path keeps
    // its case — Instagram's post codes are case-sensitive.
    const path = url.pathname.replace(/\/+$/, '');
    let query = '';
    if (kind === 'facebook_post') {
        query = FACEBOOK_ID_PARAMS.filter((p) => url.searchParams.get(p))
            .map((p) => `${p}=${url.searchParams.get(p)}`)
            .join('&');
    }
    const key = `${base}${path}${query ? `?${query}` : ''}`;
    const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 40);
    return { ok: true, link, key, id };
}

/**
 * Is a register row this same attempt? The same photo row asking again, or
 * the same engineer filing the same reward on the same install again (e.g.
 * after Feston took the first award back) — not a second use of the link.
 */
function sameAttempt(entry, { uid, registrationId, kind, productFileId }) {
    const e = entry || {};
    if (productFileId && str(e.productFileId) === productFileId) return true;
    return str(e.installerUid) === uid && str(e.registrationId) === registrationId && str(e.kind) === kind;
}

/**
 * Links saved before the register existed sit only on their photo's
 * `product_files` row; an exact match there on another photo is a duplicate too.
 */
async function usedOnAnotherPhoto(firestore, link, attempt) {
    const snap = await firestore.collection('product_files').where('installerPostLink', '==', link).limit(10).get();
    return snap.docs.some((d) => {
        if (attempt.productFileId && d.id === attempt.productFileId) return false;
        const r = d.data() || {};
        return !(str(r.uploadedBy) === attempt.uid && str(r.registrationId) === attempt.registrationId && str(r.kind) === attempt.kind);
    });
}

const DUPLICATE_MESSAGE = 'This post link has already been used. Each post can be submitted only once.';

/**
 * `POST ?action=check-post-link` — body `{ kind, link, registrationId, productFileId? }`.
 *
 * Without `productFileId` it only answers (the app asks before uploading the
 * photo). With it — a link pasted under a photo already uploaded — the link is
 * also entered in the register against that photo, so nobody else can file it.
 *
 * Always 200 with a `status` the app reads: ok · bad-link · wrong-platform ·
 * duplicate-link. Other codes are refusals of the caller, not of the link.
 */
async function checkPostLink({ firestore, verifyIdToken, authorization, body, now, logger }) {
    const bearer = /^Bearer\s+(.+)$/i.exec(str(authorization));
    if (!bearer) return reply(401, { status: 'unauthenticated' });
    let uid = '';
    try {
        uid = str((await verifyIdToken(bearer[1])).uid);
    } catch (error) {
        if (logger) logger.warn('check-post-link: token verification failed', error);
    }
    if (!uid) return reply(401, { status: 'unauthenticated' });
    const installer = await findInstallerByUid(firestore, uid);
    if (!installer || (installer.data() || {}).active === false) return reply(403, { status: 'not-installer' });

    const b = body && typeof body === 'object' ? body : {};
    const kind = str(b.kind);
    if (!takesPostLink(kind)) return reply(400, { status: 'bad-request', message: 'This kind of photo has no post link.' });
    const checked = validatePostLink(kind, b.link);
    if (!checked.ok) return reply(200, { status: checked.status, message: checked.message });

    const productFileId = str(b.productFileId);
    let registrationId = str(b.registrationId);
    if (productFileId) {
        const file = await firestore.collection('product_files').doc(productFileId).get();
        const f = file.exists ? file.data() || {} : null;
        if (!f || str(f.uploadedBy) !== uid || str(f.kind) !== kind) {
            return reply(403, { status: 'not-your-photo', message: 'That photo is not one of yours.' });
        }
        registrationId = str(f.registrationId);
    }
    const attempt = { uid, registrationId, kind, productFileId };

    if (await usedOnAnotherPhoto(firestore, checked.link, attempt)) {
        return reply(200, { status: 'duplicate-link', message: DUPLICATE_MESSAGE });
    }
    const ref = firestore.collection(REGISTER_COLLECTION).doc(checked.id);
    if (!productFileId) {
        const snap = await ref.get();
        return snap.exists && !sameAttempt(snap.data(), attempt)
            ? reply(200, { status: 'duplicate-link', message: DUPLICATE_MESSAGE })
            : reply(200, { status: 'ok' });
    }
    return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists && !sameAttempt(snap.data(), attempt)) {
            return reply(200, { status: 'duplicate-link', message: DUPLICATE_MESSAGE });
        }
        tx.set(ref, { key: checked.key, link: checked.link, kind, installerUid: uid, registrationId, productFileId, createdAt: now() });
        return reply(200, { status: 'ok' });
    });
}

module.exports = {
    REGISTER_COLLECTION,
    PLATFORMS,
    DUPLICATE_MESSAGE,
    takesPostLink,
    validatePostLink,
    sameAttempt,
    usedOnAnotherPhoto,
    checkPostLink,
};
