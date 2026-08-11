'use strict';

const crypto = require('crypto');

/**
 * Confirmation tokens.
 *
 * Under the magic-link shape the token IS the `pending_registrations` document
 * id, so it is simultaneously the lookup key and the only credential standing
 * between a stranger and a customer's name, phone, email and installation
 * address — and, with OTP not yet in place, between a stranger and completing
 * the registration. It must come from a CSPRNG and be long enough that guessing
 * is not a strategy.
 *
 * The *app* generates it now, not this service, so `isValidToken` has to accept
 * any reasonable encoding the app might use (base64url, hex) while staying
 * strict enough that the value is always a safe document id.
 */

/** 24 bytes → 192 bits, encoded as 32 url-safe characters. */
const TOKEN_BYTES = 24;

/**
 * Minimum accepted length. 22 url-safe characters is 128 bits of base64url,
 * which is the floor the handoff spec sets; 32 hex characters is also 128 bits
 * and lands comfortably above it.
 */
const TOKEN_MIN_LENGTH = 22;
const TOKEN_MAX_LENGTH = 128;

const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_MIN_LENGTH},${TOKEN_MAX_LENGTH}}$`);

function generateToken() {
    return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Shape check before the token is used as a Firestore document id.
 *
 * Rejecting the wrong shape early keeps slashes and dots — both of which mean
 * something to a document path — from ever reaching a lookup, and turns
 * scanning traffic into a cheap 404 instead of a read. The `__` prefix is
 * reserved by Firestore and would throw rather than simply miss.
 */
function isValidToken(token) {
    if (typeof token !== 'string') return false;
    if (token.startsWith('__')) return false;
    return TOKEN_PATTERN.test(token);
}

module.exports = {
    generateToken,
    isValidToken,
    TOKEN_PATTERN,
    TOKEN_MIN_LENGTH,
    TOKEN_MAX_LENGTH,
};
