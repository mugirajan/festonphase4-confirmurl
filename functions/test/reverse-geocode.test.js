'use strict';

// The app's GPS pin asks the confirm service for the address at the pin,
// which asks Google (2026-10-22). The key never leaves the server.

const test = require('node:test');
const assert = require('node:assert');
const { reverseGeocode, pinAddressFrom } = require('../lib/reverse-geocode');

const GOOGLE_CHENNAI = {
    status: 'OK',
    results: [
        {
            formatted_address: '12, 2nd Avenue, Anna Nagar West, Chennai, Tamil Nadu 600040, India',
            address_components: [
                { long_name: '12', short_name: '12', types: ['street_number'] },
                { long_name: '2nd Avenue', short_name: '2nd Ave', types: ['route'] },
                { long_name: 'Anna Nagar West', short_name: 'Anna Nagar West', types: ['sublocality_level_1', 'sublocality', 'political'] },
                { long_name: 'Chennai', short_name: 'Chennai', types: ['locality', 'political'] },
                { long_name: 'Chennai', short_name: 'Chennai', types: ['administrative_area_level_3', 'political'] },
                { long_name: 'Tamil Nadu', short_name: 'TN', types: ['administrative_area_level_1', 'political'] },
                { long_name: 'India', short_name: 'IN', types: ['country', 'political'] },
                { long_name: '600040', short_name: '600040', types: ['postal_code'] },
            ],
        },
        {
            formatted_address: 'Anna Nagar, Chennai, Tamil Nadu, India',
            address_components: [
                { long_name: 'Anna Nagar', short_name: 'Anna Nagar', types: ['neighborhood', 'political'] },
                { long_name: 'Chennai', short_name: 'Chennai', types: ['locality', 'political'] },
            ],
        },
    ],
};

const okToken = async () => ({ uid: 'engineer-1' });
const base = { verifyIdToken: okToken, authorization: 'Bearer t', apiKey: 'k', logger: { warn() {}, error() {} } };
const fetchReturning = (payload, calls = []) => async (url) => {
    calls.push(url);
    return { json: async () => payload };
};

test('maps a Google result to the app address shape', () => {
    const a = pinAddressFrom(GOOGLE_CHENNAI.results);
    assert.deepStrictEqual(a, {
        text: '12 2nd Avenue, Anna Nagar West, Chennai, Tamil Nadu, 600040',
        road: '12 2nd Avenue',
        area: 'Anna Nagar West',
        city: 'Chennai',
        state: 'Tamil Nadu',
        postcode: '600040',
        countryCode: 'IN',
        places: ['Anna Nagar', 'Anna Nagar West', 'Chennai'],
    });
});

test('answers with the address, asking Google with the key and the pin', async () => {
    const calls = [];
    const out = await reverseGeocode({ ...base, body: { lat: 13.0827, lng: 80.2707 }, fetchImpl: fetchReturning(GOOGLE_CHENNAI, calls) });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.address.city, 'Chennai');
    assert.match(calls[0], /latlng=13\.082700,80\.270700/);
    assert.match(calls[0], /key=k/);
    assert.match(calls[0], /region=in/);
});

test('no result at the pin is a 200 with a null address, not an error', async () => {
    const out = await reverseGeocode({ ...base, body: { lat: 0, lng: 0 }, fetchImpl: fetchReturning({ status: 'ZERO_RESULTS', results: [] }) });
    assert.deepStrictEqual(out, { status: 200, body: { status: 'ok', address: null } });
});

test('refuses callers without a valid ID token', async () => {
    const noHeader = await reverseGeocode({ ...base, authorization: '', body: { lat: 1, lng: 1 }, fetchImpl: fetchReturning(GOOGLE_CHENNAI) });
    assert.strictEqual(noHeader.status, 401);
    const bad = await reverseGeocode({ ...base, verifyIdToken: async () => { throw new Error('expired'); }, body: { lat: 1, lng: 1 }, fetchImpl: fetchReturning(GOOGLE_CHENNAI) });
    assert.strictEqual(bad.status, 401);
});

test('rejects a pin that is not a coordinate', async () => {
    for (const body of [{}, { lat: 'x', lng: 1 }, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }]) {
        const out = await reverseGeocode({ ...base, body, fetchImpl: fetchReturning(GOOGLE_CHENNAI) });
        assert.strictEqual(out.status, 400, JSON.stringify(body));
    }
});

test('says so when no key is configured, and when Google refuses', async () => {
    const noKey = await reverseGeocode({ ...base, apiKey: '', body: { lat: 1, lng: 1 }, fetchImpl: fetchReturning(GOOGLE_CHENNAI) });
    assert.deepStrictEqual(noKey, { status: 503, body: { status: 'not-configured' } });
    const denied = await reverseGeocode({ ...base, body: { lat: 1, lng: 1 }, fetchImpl: fetchReturning({ status: 'REQUEST_DENIED', error_message: 'API not enabled' }) });
    assert.deepStrictEqual(denied, { status: 502, body: { status: 'geocoder-error' } });
    const down = await reverseGeocode({ ...base, body: { lat: 1, lng: 1 }, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    assert.strictEqual(down.status, 502);
});
