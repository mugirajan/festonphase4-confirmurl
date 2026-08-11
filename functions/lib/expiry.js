'use strict';

/**
 * Link lifetime rules.
 *
 * Kept free of any Firebase import so the expiry decision — the one rule the
 * whole feature turns on — can be unit-tested without an emulator or a network.
 */

/**
 * 48 hours, per the app→web handoff spec.
 *
 * Note the service no longer *mints* links — the mobile app writes the pending
 * document and sets `expiresAt` on it. This constant is what the dev server and
 * the docs use, and the deadline actually enforced is always the one stored on
 * the document, never this number.
 */
const TTL_MINUTES = Number(process.env.CONFIRM_TTL_MINUTES || 48 * 60);
const TTL_MS = TTL_MINUTES * 60 * 1000;
const TTL_HOURS = TTL_MINUTES / 60;

/**
 * Reads a stored expiry into epoch millis.
 *
 * Accepts a Firestore Timestamp (has toMillis), a Date, a number, or an ISO
 * string, because the same record travels through the admin SDK, JSON and the
 * tests. Anything unreadable returns NaN and is treated as expired by
 * isExpired — failing closed is the only safe default for a consent gate.
 */
function toMillis(value) {
    if (value === null || value === undefined) return NaN;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Date.parse(value);
    return NaN;
}

/**
 * True once the link has lapsed.
 *
 * A missing or unparseable expiry counts as expired: a confirmation record with
 * no readable deadline must never be confirmable.
 */
function isExpired(expiresAt, now = Date.now()) {
    const millis = toMillis(expiresAt);
    if (!Number.isFinite(millis)) return true;
    return millis <= now;
}

/** Whole seconds left, floored at zero. Drives the countdown on the page. */
function secondsRemaining(expiresAt, now = Date.now()) {
    const millis = toMillis(expiresAt);
    if (!Number.isFinite(millis)) return 0;
    return Math.max(0, Math.floor((millis - now) / 1000));
}

/** Epoch millis at which a link minted right now would lapse. */
function expiryFrom(now = Date.now()) {
    return now + TTL_MS;
}

module.exports = { TTL_MINUTES, TTL_HOURS, TTL_MS, toMillis, isExpired, secondsRemaining, expiryFrom };
