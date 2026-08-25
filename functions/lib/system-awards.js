'use strict';

/**
 * The points the SYSTEM works out (P6 / B4) — nobody claims these.
 *
 * Three rules in the scheme are derived from facts already recorded rather than
 * submitted with evidence. They are computed here, at registration completion,
 * because that is the moment all three facts are known.
 *
 *   registration_within_48h  25  the install was registered promptly
 *   new_se_first_install    100  this engineer's first completed install
 *   customer_email_verified  10  the customer confirmed their address
 *
 * Deriving them rather than claiming them is deliberate: asking an installer to
 * claim "I registered this within 48 hours" would invite claiming it when it was
 * not true, and the timestamps to check it are already on the record.
 *
 * Pure module — no Firestore, no admin SDK. The caller does the reads and the
 * writes; this decides.
 */

/** Hours an installer has to register an install and still earn the bonus. */
const PROMPT_REGISTRATION_HOURS = 48;

/**
 * Anything the record might hold a date in, as a millisecond timestamp.
 *
 * `installationDate` is a plain "2026-08-25" string; `createdAt` is a Firestore
 * Timestamp. Returns null rather than guessing, and a null anywhere means the
 * rule cannot be judged — which is treated as NOT earned rather than earned, so
 * a missing field never pays out by accident.
 */
function toMillis(value) {
    if (!value) return null;
    if (typeof value.toDate === 'function') {
        const d = value.toDate();
        return d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : null;
    }
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        // A bare YYYY-MM-DD parses as UTC midnight, which is what we want: the
        // installer gets the whole of the install day before the clock starts.
        const d = new Date(trimmed);
        return Number.isFinite(d.getTime()) ? d.getTime() : null;
    }
    return null;
}

/**
 * Was this install registered within the window?
 *
 * ── Which two moments ───────────────────────────────────────────────────────
 * From the INSTALL DATE to the moment the installer SUBMITTED the registration —
 * not to the moment the customer confirmed it. An installer stages the pending
 * record and hands over a link; whether the customer opens it in an hour or a
 * week is not something the installer controls, and charging them for it would
 * make the bonus a lottery on the customer's habits.
 *
 * ── Which end of the install day ────────────────────────────────────────────
 * The date is recorded without a time, so the window opens at midnight UTC on
 * the install day. That is the generous reading — an install finished at 6pm and
 * registered 40 hours later still counts — and generous is right for a
 * tie-break the installer cannot re-run.
 *
 * A submission BEFORE the install date is not an error to punish: dates are
 * typed by hand and time zones move them. Anything at or before the deadline
 * earns it.
 */
function registeredPromptly(installationDate, submittedAt, hours = PROMPT_REGISTRATION_HOURS) {
    const installed = toMillis(installationDate);
    const submitted = toMillis(submittedAt);
    // Either missing means the rule cannot be judged. Not earned.
    if (installed === null || submitted === null) return false;
    return submitted <= installed + hours * 60 * 60 * 1000;
}

/**
 * Is this the engineer's first completed install?
 *
 * Read from the installer document BEFORE the transaction increments it, so 0 or
 * a missing field means the one being completed right now is their first.
 *
 * ⚠ The award is owed to the COMPANY, not to the engineer — the scheme rewards
 * a firm for onboarding somebody who then went and did the work. It is keyed on
 * the ENGINEER, so a company earns it once per new engineer rather than once
 * ever.
 */
function isFirstInstall(installerDocData) {
    const n = Number((installerDocData || {}).lifetimeInstalls);
    return !Number.isFinite(n) || n <= 0;
}

module.exports = {
    PROMPT_REGISTRATION_HOURS,
    toMillis,
    registeredPromptly,
    isFirstInstall,
};
