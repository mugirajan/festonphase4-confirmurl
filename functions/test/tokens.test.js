'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    generateToken,
    isValidToken,
    TOKEN_MIN_LENGTH,
    TOKEN_MAX_LENGTH,
} = require('../lib/tokens');

test('generated tokens are 32 url-safe characters', () => {
    const token = generateToken();
    assert.equal(token.length, 32);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
});

test('tokens do not repeat', () => {
    const seen = new Set();
    for (let i = 0; i < 2_000; i += 1) seen.add(generateToken());
    assert.equal(seen.size, 2_000);
});

test('a generated token validates', () => {
    assert.equal(isValidToken(generateToken()), true);
});

test('the encodings the app might use are all accepted', () => {
    // 32 hex characters — 128 bits, the floor the handoff spec sets.
    assert.equal(isValidToken('a17f9c4e8b2d6051a17f9c4e8b2d6051'), true);
    // 22 base64url characters — 128 bits, the shortest form accepted.
    assert.equal(isValidToken('a'.repeat(TOKEN_MIN_LENGTH)), true);
    // A Firestore auto-id is 20 characters and is deliberately NOT enough on
    // its own: under the magic-link shape the id is the only credential.
    assert.equal(isValidToken('k3Jd9fLmNqA2bXcE1Zpr'), false);
});

test('path characters are rejected before a token reaches a document lookup', () => {
    assert.equal(isValidToken('../../admins/someone'), false);
    assert.equal(isValidToken('abc/def'), false);
    assert.equal(isValidToken('.'), false);
    assert.equal(isValidToken('..'), false);
    assert.equal(isValidToken('a'.repeat(30) + '.'), false);
});

test('the Firestore-reserved prefix is rejected', () => {
    assert.equal(isValidToken('__' + 'a'.repeat(30)), false);
});

test('wrong-length and non-string tokens are rejected', () => {
    assert.equal(isValidToken('short'), false);
    assert.equal(isValidToken('a'.repeat(TOKEN_MIN_LENGTH - 1)), false);
    assert.equal(isValidToken('a'.repeat(TOKEN_MAX_LENGTH + 1)), false);
    assert.equal(isValidToken(''), false);
    assert.equal(isValidToken(null), false);
    assert.equal(isValidToken(undefined), false);
    assert.equal(isValidToken(12345), false);
});
