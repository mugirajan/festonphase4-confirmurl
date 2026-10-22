'use strict';

/**
 * `?action=reverse-geocode` — the written address at a map pin (2026-10-22).
 *
 * The app's GPS step shows the address under the pin and checks it against
 * the customer's address. It used OpenStreetMap's free geocoder, whose Indian
 * coverage is thin: the name often came back empty. This asks Google's
 * Geocoding API instead, from here rather than from the phone, so the API key
 * stays on the server (a Geocoding key cannot be locked to an Android app).
 *
 * Signed-in callers only — the ID token is checked, nothing else is read.
 * Returns the same shape the app's `reverseGeocode` built from OpenStreetMap,
 * so the step and the site check are unchanged:
 *
 *   { address: { text, road, area, city, state, postcode, countryCode, places } | null }
 */

const { GEOCODING_API_KEY } = require('./config');

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const reply = (status, body) => ({ status, body });

/** One Google result's address_components → the app's PinAddress fields. */
function pinAddressFrom(results) {
    if (!Array.isArray(results) || !results.length) return null;
    const first = results[0];
    const comps = Array.isArray(first.address_components) ? first.address_components : [];
    const pick = (type, field = 'long_name') => {
        const c = comps.find((x) => Array.isArray(x.types) && x.types.includes(type));
        return c ? str(c[field]) : '';
    };

    const road = [pick('street_number'), pick('route')].filter(Boolean).join(' ');
    const area = pick('sublocality_level_1') || pick('sublocality') || pick('neighborhood') || pick('sublocality_level_2');
    const city = pick('locality') || pick('administrative_area_level_3') || pick('administrative_area_level_2');
    const state = pick('administrative_area_level_1');
    const postcode = pick('postal_code');
    const countryCode = pick('country', 'short_name').toUpperCase();

    // Every place name Google gave across its results, most specific first.
    // The city typed on the form can be any of these (a suburb, a taluk, a
    // district), exactly as with the OpenStreetMap list before.
    const PLACE_TYPES = [
        'neighborhood',
        'sublocality_level_2',
        'sublocality_level_1',
        'sublocality',
        'locality',
        'administrative_area_level_3',
        'administrative_area_level_2',
    ];
    const places = [];
    for (const r of results) {
        for (const c of Array.isArray(r.address_components) ? r.address_components : []) {
            if (!Array.isArray(c.types) || !PLACE_TYPES.some((t) => c.types.includes(t))) continue;
            const name = str(c.long_name);
            if (name && !places.includes(name)) places.push(name);
        }
    }
    places.sort((a, b) => rank(results, a) - rank(results, b));

    const text = [road, area, city, state, postcode].filter(Boolean).join(', ') || str(first.formatted_address);
    return text ? { text, road, area, city, state, postcode, countryCode, places } : null;
}

/** Order places by how specific their type is (smaller is more specific). */
function rank(results, name) {
    const ORDER = ['neighborhood', 'sublocality_level_2', 'sublocality_level_1', 'sublocality', 'locality', 'administrative_area_level_3', 'administrative_area_level_2'];
    for (const r of results) {
        for (const c of r.address_components || []) {
            if (str(c.long_name) !== name) continue;
            const i = ORDER.findIndex((t) => (c.types || []).includes(t));
            if (i > -1) return i;
        }
    }
    return ORDER.length;
}

async function reverseGeocode({ verifyIdToken, authorization, body, logger, fetchImpl = fetch, apiKey = GEOCODING_API_KEY }) {
    const bearer = /^Bearer\s+(.+)$/i.exec(str(authorization));
    if (!bearer) return reply(401, { status: 'unauthenticated' });
    let uid = '';
    try {
        uid = str((await verifyIdToken(bearer[1])).uid);
    } catch (error) {
        if (logger) logger.warn('reverse-geocode: token verification failed', error);
    }
    if (!uid) return reply(401, { status: 'unauthenticated' });

    const lat = Number(body && body.lat);
    const lng = Number(body && body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return reply(400, { status: 'bad-request' });
    }
    if (!apiKey) return reply(503, { status: 'not-configured' });

    const url = `${GEOCODE_URL}?latlng=${lat.toFixed(6)},${lng.toFixed(6)}&region=in&language=en&key=${encodeURIComponent(apiKey)}`;
    let data;
    try {
        const res = await fetchImpl(url);
        data = await res.json();
    } catch (error) {
        if (logger) logger.error('reverse-geocode: Google request failed', error);
        return reply(502, { status: 'geocoder-error' });
    }
    const status = str(data && data.status);
    if (status === 'ZERO_RESULTS') return reply(200, { status: 'ok', address: null });
    if (status !== 'OK') {
        if (logger) logger.error('reverse-geocode: Google refused', { status, message: data && data.error_message });
        return reply(502, { status: 'geocoder-error' });
    }
    return reply(200, { status: 'ok', address: pinAddressFrom(data.results) });
}

module.exports = { reverseGeocode, pinAddressFrom };
