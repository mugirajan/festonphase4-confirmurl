'use strict';

/**
 * End to end: a registration lands, a certificate comes out.
 *
 * This is the only place that knows the whole sequence. `index.js` supplies the
 * trigger and nothing else, so the sequence can be driven from a script or a
 * test without a Firestore event.
 *
 * Ordering matters and is not accidental:
 *
 *   1. plan()      transactional; reserves the number, marks it `rendering`.
 *   2. render()    Chrome + Storage. Slow, outside the transaction.
 *   3. mark ready  the customer's app is listening on this document, and it is
 *                  only true once the FILES exist. A client that sees `ready`
 *                  and then 404s on the image is worse than one that waits.
 *   4. email       last, because a send cannot be recalled. If the render
 *                  failed there is nothing worth emailing about.
 */

const admin = require('firebase-admin');
const { HERO_COLLECTION, HERO_EMAIL_ENABLED, MAIL_COLLECTION } = require('./config');
const { loadRegistrations, plan, render, signedUrl, millisOf } = require('./hero-issue');
const { buildMailDocument } = require('./hero-mail');
const mailer = require('./mailer');

/**
 * Issues (or re-issues) the certificate for one customer.
 *
 * Returns a small result object describing what happened, which is what the
 * trigger logs. Throws only on a genuine failure, so the platform's own retry
 * is what handles a transient Chrome or Storage error.
 */
async function issueForUser(uid, { logger = console } = {}) {
    const firestore = admin.firestore();
    const registrations = await loadRegistrations(firestore, uid);
    if (!registrations.length) return { action: 'skip', reason: 'no-registrations' };

    const decision = await plan(firestore, uid, registrations);
    if (decision.action === 'skip') {
        return { action: 'skip', reason: decision.reason };
    }

    const ref = firestore.collection(HERO_COLLECTION).doc(uid);

    // Re-read: `issuedAt` was a server sentinel inside the transaction and is
    // only a real timestamp now it has committed. The date printed on the
    // certificate comes from here.
    const snap = await ref.get();
    const certificate = { uid, ...(snap.exists ? snap.data() : decision.certificate) };

    let files;
    try {
        files = await render(certificate);
    } catch (error) {
        // Leave a readable trail on the document itself rather than only in a
        // log that rotates. `status` stays non-ready so no client shows a
        // certificate whose files do not exist.
        await ref.set(
            {
                status: 'error',
                renderError: String(error && error.message ? error.message : error).slice(0, 500),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
        );
        throw error;
    }

    await ref.set(
        {
            status: 'ready',
            pngPath: files.pngPath,
            pdfPath: files.pdfPath,
            pngBytes: files.pngBytes,
            pdfBytes: files.pdfBytes,
            renderError: admin.firestore.FieldValue.delete(),
            renderedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
    );

    const emailed = await queueEmail(firestore, certificate, files, decision.action, logger);

    return {
        action: decision.action,
        certificateNumber: certificate.certificateNumber,
        capacityKw: certificate.capacityKw,
        co2Tonnes: certificate.co2Tonnes,
        version: certificate.version,
        emailed,
    };
}

/**
 * Queues the certificate email.
 *
 * Never allowed to fail the issue. The certificate itself is already written
 * and visible in the app and the portal by this point; losing the email is a
 * smaller harm than throwing, which would make the platform retry the whole
 * function and render the thing again.
 */
async function queueEmail(firestore, certificate, files, action, logger) {
    if (!HERO_EMAIL_ENABLED) return false;
    const to = String(certificate.customerEmail || '').trim();
    if (!to) {
        logger.warn('hero certificate: no email address on file', {
            uid: certificate.uid,
            certificateNumber: certificate.certificateNumber,
        });
        return false;
    }

    try {
        const [pngUrl, pdfUrl] = await Promise.all([
            signedUrl(files.pngPath),
            signedUrl(files.pdfPath),
        ]);
        const mailRef = await firestore.collection(MAIL_COLLECTION).add({
            ...buildMailDocument({
                to,
                customerName: certificate.customerName,
                certificateNumber: certificate.certificateNumber,
                co2Tonnes: certificate.co2Tonnes,
                trees: certificate.trees,
                isReissue: action === 'update',
                pngUrl,
                pdfUrl,
            }),
            // Ours, not the extension's. Lets a support query answer "was this
            // customer sent their certificate, and which version".
            heroUid: certificate.uid,
            heroCertificateNumber: certificate.certificateNumber,
            heroVersion: certificate.version,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Queue first, then drain. The document is the audit trail — when a
        // customer says they never got their certificate, `delivery.state` says
        // whether we tried and what happened — and it survives even if the send
        // never runs. `sendQueued` never throws, and with no SMTP configured it
        // simply leaves the document PENDING for whenever credentials exist.
        const sent = await mailer.sendQueued(mailRef.id);
        if (!sent.sent && sent.reason === 'error') {
            logger.warn('hero certificate: the email failed to send', {
                uid: certificate.uid,
                mailDocId: mailRef.id,
                error: sent.error,
            });
        }
        return true;
    } catch (error) {
        logger.error('hero certificate: could not queue the email', {
            uid: certificate.uid,
            error: String(error && error.message ? error.message : error),
        });
        return false;
    }
}

/**
 * The owner of a newly created registration.
 *
 * `userId` is the field the confirm service stamps on every registration it
 * writes, and it is the CUSTOMER even when an installer filled the form in.
 */
function uidFromRegistration(data) {
    const uid = data && typeof data.userId === 'string' ? data.userId.trim() : '';
    return uid || null;
}

module.exports = { issueForUser, queueEmail, uidFromRegistration, millisOf };
