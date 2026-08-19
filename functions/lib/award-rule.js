'use strict';

/**
 * What an install earns — SERVER SIDE (P6 / B4).
 *
 * A twin of `resolveAward` in
 * `feston-care/src/app/components/points-config/points-rates.types.ts`. Same
 * duplication rationale as everywhere else in this pair of repos: nothing joins
 * Angular TypeScript to CommonJS on Node, and a build step for one pure function
 * costs more than it saves. THIS copy decides what is actually awarded; the
 * portal's renders the preview and the warnings.
 *
 * Per-kW applies only when a rate is configured AND active AND the capacity is
 * known. Any of those missing falls back to the flat action value — so an
 * install never earns nothing merely because Feston has not priced its family,
 * and a serial missing from inventory does not cost the installer their award.
 *
 * Rounded, not floored: the error is at most half a point, and floor would
 * systematically shortchange the installer.
 */
function resolveAward(input) {
    const flat = Number(input.flatPoints);
    const safeFlat = Number.isFinite(flat) && flat > 0 ? Math.round(flat) : 0;

    const rate = Number(input.ratePerKw);
    const kw = Number(input.capacityKw);

    const usable =
        input.rateActive !== false &&
        Number.isFinite(rate) &&
        rate > 0 &&
        Number.isFinite(kw) &&
        kw > 0;

    if (!usable) return { points: safeFlat, basis: 'flat' };

    const points = Math.round(rate * kw);
    // A rate that computes to nothing is not an award — fall back rather than
    // paying zero for real work.
    return points > 0 ? { points, basis: 'per-kw' } : { points: safeFlat, basis: 'flat' };
}

module.exports = { resolveAward };
