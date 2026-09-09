'use strict';

/**
 * Solar Super Hero — the environmental figures printed on the certificate.
 *
 * Deliberately free of every Firebase import: these numbers go on a document a
 * customer may show people, so the arithmetic behind them has to be unit
 * testable on its own, and readable by someone who wants to check the claim.
 *
 * Two constants do all the work, and both are cited rather than invented:
 *
 *   SPECIFIC_YIELD  1,450 kWh generated per kWp per year. The usual planning
 *                   figure for Indian rooftop solar; MNRE/CEA rooftop studies
 *                   put real systems in the 1,300-1,600 band depending on
 *                   latitude, tilt and soiling, and 1,450 sits mid-range.
 *   GRID_FACTOR     0.71 kg CO2 avoided per kWh — the CEA CO2 Baseline
 *                   Database combined-margin factor for the Indian grid. Solar
 *                   displaces grid electricity, so this is what it avoids.
 *
 * TREES_PER_TONNE is not a physical constant and is not treated as one. It is
 * the ratio the APPROVED DESIGN already prints: the artwork shows "5 tonnes"
 * beside "about 80 trees", i.e. 16 trees per tonne. Deriving trees from a
 * different sequestration figure would have made the shipped certificate
 * disagree with the design Feston signed off, so the design's own ratio is the
 * one implemented. Every certificate is therefore self-consistent with the
 * artwork, and a 5 kW system still reads "5 tonnes / 80 trees" exactly as the
 * mock-up does.
 */

/** kWh per kWp per year — Indian rooftop planning figure. */
const SPECIFIC_YIELD = 1450;

/** kg CO2 avoided per kWh of grid electricity displaced (CEA combined margin). */
const GRID_FACTOR = 0.71;

/** Trees per tonne, taken from the approved artwork's own 5 t : 80 trees. */
const TREES_PER_TONNE = 16;

/**
 * Total installed capacity, in kW, from a set of registrations.
 *
 * The certificate is issued once per CUSTOMER, not once per product, so a
 * customer who registers a second system gets the same certificate number back
 * with a larger figure on it. That means summing, and it means being liberal
 * about how capacity was recorded: the estate has it as a bare number, as a
 * string, and as a string with the unit appended ("5 kW", "5.5kw"). Anything
 * that yields no positive number contributes nothing rather than poisoning the
 * sum with NaN.
 */
function capacityKw(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
    if (typeof value !== 'string') return 0;
    // Leading number, unit and any surrounding text ignored. `parseFloat` would
    // accept "5kW" too, but this rejects "kW5" rather than silently reading 0.
    const match = value.trim().match(/^(\d+(?:\.\d+)?)/);
    if (!match) return 0;
    const n = Number(match[1]);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Sums the capacity across every registration a customer owns.
 *
 * `capacity` is the field the portal and the warranty certificate both read;
 * `kilowatt` is the mobile app's older spelling for the same fact. Both are
 * checked, in that order, so a mixed-vintage account still totals correctly.
 */
function totalCapacityKw(registrations = []) {
    let total = 0;
    for (const reg of registrations) {
        if (!reg) continue;
        total += capacityKw(reg.capacity) || capacityKw(reg.kilowatt);
    }
    // Capacities carry one decimal at most; float addition of 1.1-style values
    // otherwise leaves 8.799999999999999 to be printed.
    return Math.round(total * 100) / 100;
}

/**
 * The two figures the certificate prints, from a total capacity in kW.
 *
 * Both are rounded to whole units because the artwork says "an estimated" and
 * "about" — a certificate claiming 5.15 tonnes and 82.4 trees would be
 * spuriously precise about a number that is a planning estimate either way.
 *
 * A system too small to round to a full tonne still reports 1, never 0: the
 * certificate exists to thank someone for going solar, and "offsets an
 * estimated 0 tonnes" is both dispiriting and wrong — a sub-tonne system still
 * offsets something.
 */
function impactFor(totalKw) {
    const kw = capacityKw(totalKw);
    if (!kw) return { capacityKw: 0, co2Tonnes: 0, trees: 0 };
    const tonnesExact = (kw * SPECIFIC_YIELD * GRID_FACTOR) / 1000;
    const co2Tonnes = Math.max(1, Math.round(tonnesExact));
    return {
        capacityKw: kw,
        co2Tonnes,
        trees: co2Tonnes * TREES_PER_TONNE,
    };
}

module.exports = {
    SPECIFIC_YIELD,
    GRID_FACTOR,
    TREES_PER_TONNE,
    capacityKw,
    totalCapacityKw,
    impactFor,
};
