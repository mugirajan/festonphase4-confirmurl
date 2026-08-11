'use strict';

/**
 * Display helpers, mirroring how feston-care presents the same fields so a
 * customer sees identical wording on the confirmation page and on the
 * certificate they later download.
 *
 * These are copies, not imports — this project is deliberately standalone and
 * does not reach into the feston-care tree.
 */

const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/**
 * Escapes a value for interpolation into HTML.
 *
 * Every customer-supplied string on the page goes through this. The details are
 * typed by an installer into a mobile form and stored verbatim, so they are
 * untrusted input as far as this page is concerned.
 */
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** Trims to a string; anything non-string becomes ''. */
function asString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/** Customer-facing long form of a product family. */
function familyLongName(family) {
    switch (asString(family).toLowerCase()) {
        case 'ongrid':
            return 'On Grid Inverter';
        case 'hybrid':
            return 'Hybrid Inverter';
        case 'micro-inverter':
            return 'Micro Inverter';
        case 'batteries':
            return 'Batteries';
        default:
            return asString(family);
    }
}

/**
 * Phase arrives as "1" / "3" / "1 phase" / "3 phase" depending on the vintage of
 * the row. Normalise to the two forms a customer recognises.
 */
function phaseDisplay(phase) {
    const p = asString(phase).toLowerCase();
    if (!p) return '';
    if (['1', '1 phase', 'single', 'single phase'].includes(p)) return 'Single Phase';
    if (['3', '3 phase', 'three', 'three phase'].includes(p)) return 'Three Phase';
    return asString(phase);
}

/** Capacity is stored as a bare number ("3.0", "5"). Drop the trailing .0, add the unit. */
function capacityDisplay(capacity) {
    const c = asString(capacity);
    if (!c) return '';
    return `${c.replace(/\.0+$/, '')} Kw`;
}

/**
 * Anything date-shaped → "YYYY-MM-DD".
 *
 * The two writers disagree: the portal wizard stores `warrantyEndDate` as a
 * plain string, the mobile app stores it as a Firestore Timestamp. Both reach
 * this project as data read off the same document, so both are normalised here
 * rather than at each call site. Anything unrecognised comes back as ''.
 */
function toDateString(value) {
    if (!value) return '';

    if (typeof value === 'string') {
        // Tolerates a full ISO datetime as well as a bare date.
        const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
        return match ? match[1] : value.trim();
    }

    // Firestore Timestamp (admin SDK), a Date, or the {seconds} shape a
    // Timestamp decays to when it has been through JSON.
    let date = null;
    if (typeof value.toDate === 'function') date = value.toDate();
    else if (value instanceof Date) date = value;
    else if (typeof value.seconds === 'number') date = new Date(value.seconds * 1000);
    else if (typeof value._seconds === 'number') date = new Date(value._seconds * 1000);

    if (!date || Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
}

/** YYYY-MM-DD → "07 Aug 2026". Anything unparseable is returned untouched. */
function dateDisplay(value) {
    const raw = asString(value);
    if (!raw) return '';
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!match) return raw;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthIndex = Number(match[2]) - 1;
    if (monthIndex < 0 || monthIndex > 11) return raw;
    return `${match[3]} ${months[monthIndex]} ${match[1]}`;
}

/** "58 minutes" / "45 seconds" — the human half of the expiry notice. */
function humaniseSeconds(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    if (!remainder) return `${hours} hour${hours === 1 ? '' : 's'}`;
    return `${hours} hour${hours === 1 ? '' : 's'} ${remainder} minute${remainder === 1 ? '' : 's'}`;
}

module.exports = {
    escapeHtml,
    asString,
    familyLongName,
    phaseDisplay,
    capacityDisplay,
    toDateString,
    dateDisplay,
    humaniseSeconds,
};
