'use strict';

/**
 * Solar Super Hero certificate numbers.
 *
 * `FSV-SSH-2026-00041` — the shape the artwork prints. Feston SEV · Solar Super
 * Hero · the year of FIRST issue · a zero-padded sequence.
 *
 * The number is allocated once per customer and never changes. That is the
 * whole point of a certificate number: a customer who registers a second system
 * gets the same certificate back with a larger CO2 figure on it, not a new
 * identity. So the year stays the year they first went solar with Feston, even
 * when the document is re-rendered years later, and the sequence is read from
 * the stored certificate on every reissue rather than re-allocated.
 *
 * The sequence lives in a single counter document and is incremented inside the
 * same transaction that creates the certificate. Two customers confirming in
 * the same second therefore serialise on that document rather than colliding —
 * a duplicate certificate number would be worse than a slow one.
 */

const COUNTER_COLLECTION = 'counters';
const COUNTER_DOC = 'hero_certificates';
const PREFIX = 'FSV-SSH';
const PAD = 5;

/**
 * Where the sequence starts.
 *
 * The design mock-up shows 00041 and Feston have issued certificates by hand
 * before this system existed, so starting at 1 would mint numbers that may
 * already be on paper somewhere. Overridable per environment; the production
 * value is the one Feston confirm.
 */
const SEQUENCE_START = Number(process.env.HERO_SEQUENCE_START || 1);

/** `FSV-SSH-2026-00041` from its parts. */
function formatNumber(year, sequence) {
    const y = String(year).padStart(4, '0');
    return `${PREFIX}-${y}-${String(sequence).padStart(PAD, '0')}`;
}

/** The calendar year in India, which is where every Feston customer is. */
function issueYear(date = new Date()) {
    return Number(
        new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: 'Asia/Kolkata' }).format(date),
    );
}

/**
 * Reads the counter and returns the next sequence value.
 *
 * Must be called with a transaction that will also write the certificate, and
 * the caller must apply `commit` inside that same transaction — the read and
 * the write are split so the caller can abandon the allocation if it decides
 * not to issue after all, without having burned a number.
 */
async function allocateSequence(tx, firestore) {
    const ref = firestore.collection(COUNTER_COLLECTION).doc(COUNTER_DOC);
    const snap = await tx.get(ref);
    const current = snap.exists ? Number(snap.data().next) : NaN;
    const next = Number.isFinite(current) && current >= SEQUENCE_START ? current : SEQUENCE_START;
    return {
        sequence: next,
        /** Call inside the same transaction once the certificate is being written. */
        commit: () => tx.set(ref, { next: next + 1 }, { merge: true }),
    };
}

module.exports = {
    COUNTER_COLLECTION,
    COUNTER_DOC,
    PREFIX,
    SEQUENCE_START,
    formatNumber,
    issueYear,
    allocateSequence,
};
