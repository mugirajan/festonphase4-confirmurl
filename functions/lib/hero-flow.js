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
const {
    HERO_COLLECTION,
    HERO_ENABLED,
    HERO_EMAIL_ENABLED,
    MAIL_COLLECTION,
    WARRANTY_ENABLED,
    heroPageUrl,
    REGISTRATIONS_COLLECTION,
} = require('./config');
const { loadRegistrations, plan, render, signedUrl, millisOf, bucket } = require('./hero-issue');
const { buildMailDocument, buildWarrantyMailDocument } = require('./hero-mail');
const { issueWarranty, markEmailed, warrantyFilename } = require('./warranty-certificate');
const { issueTestReport, testReportFilename } = require('./test-report');
const { renderLayout } = require('./hero-render');
const mailer = require('./mailer');

/**
 * Issues (or re-issues) the certificate for one customer — and, since
 * 2026-10-22, the WARRANTY certificate for the registration that triggered it,
 * at the same time and in the same email.
 *
 * The warranty is issued first and never blocks the hero certificate. If it
 * fails, the hero work still completes and the function then throws, so the
 * platform's retry issues the warranty: on that retry the hero plan reads
 * "unchanged" and the warranty goes out in an email of its own.
 *
 * Returns a small result object describing what happened, which is what the
 * trigger logs. Throws only on a genuine failure, so the platform's own retry
 * is what handles a transient Chrome or Storage error.
 */
async function issueForUser(uid, { logger = console, registrationId = '', registration = null } = {}) {
    const firestore = admin.firestore();

    let warranty = null;
    let warrantyError = null;
    if (WARRANTY_ENABLED && registrationId && registration) {
        try {
            warranty = await issueWarranty(firestore, registrationId, registration, { renderLayout, bucket });
            // The factory test report rides with the warranty (2026-10-23): same
            // email, same "once per registration" rule. Its failure is logged
            // but never blocks the warranty or the hero certificate.
            try {
                warranty.testReport = await issueTestReport(firestore, registrationId, registration, { renderLayout, bucket });
            } catch (error) {
                logger.error('test report: could not issue', {
                    registrationId,
                    error: String(error && error.message ? error.message : error),
                });
            }
        } catch (error) {
            warrantyError = error;
            logger.error('warranty certificate: could not issue', {
                uid,
                registrationId,
                error: String(error && error.message ? error.message : error),
            });
        }
    }

    // A Feston battery's own row (2026-10-27): its certificates are issued
    // above, but the hero certificate and the email belong to the inverter's
    // flow, which attaches them. Nothing more to do here.
    if (registration && registration.parentRegistrationId) {
        if (warrantyError) throw warrantyError;
        return { action: 'skip', reason: 'battery-row', warranty: warranty ? warranty.pdfPath : null };
    }

    // The batteries installed with this inverter: one certificate each, carried
    // in the same email as the inverter's.
    if (warranty && registrationId) {
        warranty.extras = await issueBatteryCertificates(firestore, registrationId, logger);
    }

    const result = await issueHero(firestore, uid, warranty, logger);
    if (warrantyError) throw warrantyError;
    return { ...result, warranty: warranty ? warranty.pdfPath : null };
}

/**
 * The warranty certificate and test report of every Feston battery row under
 * an inverter's registration (store.js writes them in the same transaction).
 * Idempotent like the inverter's own; a battery already emailed is left out.
 */
async function issueBatteryCertificates(firestore, parentRegistrationId, logger) {
    const extras = [];
    let snap;
    try {
        snap = await firestore
            .collection(REGISTRATIONS_COLLECTION)
            .where('parentRegistrationId', '==', parentRegistrationId)
            .get();
    } catch (error) {
        logger.error('battery certificates: could not list the battery rows', {
            parentRegistrationId,
            error: String(error && error.message ? error.message : error),
        });
        return extras;
    }
    for (const d of snap.docs) {
        const row = d.data() || {};
        try {
            const w = await issueWarranty(firestore, d.id, row, { renderLayout, bucket });
            if (w.emailedAt) continue;
            let testReport = null;
            try {
                testReport = await issueTestReport(firestore, d.id, row, { renderLayout, bucket });
            } catch (error) {
                logger.error('battery test report: could not issue', { registrationId: d.id, error: String(error && error.message ? error.message : error) });
            }
            extras.push({
                registrationId: d.id,
                serialnumber: w.serialnumber,
                pdfPath: w.pdfPath,
                testReportPath: testReport && testReport.pdfPath ? testReport.pdfPath : '',
            });
        } catch (error) {
            logger.error('battery warranty certificate: could not issue', { registrationId: d.id, error: String(error && error.message ? error.message : error) });
        }
    }
    return extras;
}

/** Signed URLs for the battery certificates, in the shape the mail builders take. */
async function extrasForMail(extras) {
    const out = [];
    for (const e of extras || []) {
        const [url, testReportUrl] = await Promise.all([
            signedUrl(e.pdfPath),
            e.testReportPath ? signedUrl(e.testReportPath) : Promise.resolve(''),
        ]);
        out.push({
            registrationId: e.registrationId,
            serial: e.serialnumber,
            url,
            filename: warrantyFilename(e.serialnumber),
            testReportUrl,
            testReportFilename: testReportFilename(e.serialnumber),
        });
    }
    return out;
}

/** The hero certificate itself; `warranty` (or null) rides along in its email. */
async function issueHero(firestore, uid, warranty, logger) {
    if (!HERO_ENABLED) {
        const emailedWarranty = await queueWarrantyEmail(firestore, warranty, logger);
        return { action: 'skip', reason: 'hero-disabled', emailedWarranty };
    }

    const registrations = await loadRegistrations(firestore, uid);
    if (!registrations.length) {
        const emailedWarranty = await queueWarrantyEmail(firestore, warranty, logger);
        return { action: 'skip', reason: 'no-registrations', emailedWarranty };
    }

    const decision = await plan(firestore, uid, registrations);
    if (decision.action === 'skip') {
        // Nothing new on the hero certificate, so no hero email — but the
        // warranty for this product still goes out, on its own.
        const emailedWarranty = await queueWarrantyEmail(firestore, warranty, logger);
        return { action: 'skip', reason: decision.reason, emailedWarranty };
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
            // Every rendered file: pngPath/pdfPath (landscape), portraitPngPath,
            // portraitPdfPath, storyPngPath and their byte counts.
            ...files,
            // The certificate's own web page, where all of those can be viewed
            // and downloaded without the app.
            pageUrl: heroPageUrl(certificate.certificateNumber),
            renderError: admin.firestore.FieldValue.delete(),
            renderedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
    );

    const emailed = await queueEmail(firestore, certificate, files, decision.action, logger, warranty);

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
async function queueEmail(firestore, certificate, files, action, logger, warranty = null) {
    if (!HERO_EMAIL_ENABLED) return false;
    const to = String(certificate.customerEmail || '').trim();
    if (!to) {
        logger.warn('hero certificate: no email address on file', {
            uid: certificate.uid,
            certificateNumber: certificate.certificateNumber,
        });
        return false;
    }

    // Attach the warranty only if it has not been emailed already (a retry).
    const attachWarranty = !!(warranty && warranty.pdfPath && !warranty.emailedAt);

    try {
        const testReportPath = attachWarranty && warranty.testReport ? warranty.testReport.pdfPath : '';
        const [pngUrl, pdfUrl, warrantyUrl, testReportUrl] = await Promise.all([
            signedUrl(files.pngPath),
            signedUrl(files.pdfPath),
            attachWarranty ? signedUrl(warranty.pdfPath) : Promise.resolve(''),
            testReportPath ? signedUrl(testReportPath) : Promise.resolve(''),
        ]);
        // The batteries' certificates ride along with the inverter's (2026-10-27).
        const extras = attachWarranty ? await extrasForMail(warranty.extras) : [];
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
                pageUrl: heroPageUrl(certificate.certificateNumber),
                warranty: warrantyUrl
                    ? {
                          url: warrantyUrl,
                          filename: warrantyFilename(warranty.serialnumber),
                          serial: warranty.serialnumber,
                          testReportUrl,
                          testReportFilename: testReportFilename(warranty.serialnumber),
                      }
                    : null,
                extras,
            }),
            // Ours, not the extension's. Lets a support query answer "was this
            // customer sent their certificate, and which version".
            heroUid: certificate.uid,
            heroCertificateNumber: certificate.certificateNumber,
            heroVersion: certificate.version,
            ...(warrantyUrl ? { warrantyRegistrationId: warranty.registrationId } : {}),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        if (warrantyUrl) await markEmailed(firestore, warranty.registrationId);
        for (const e of extras) await markEmailed(firestore, e.registrationId);

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
 * The warranty certificate on its own, for when there is no hero email to
 * carry it. Never throws, for the same reason as queueEmail; once queued it is
 * marked emailed so a retry does not send it twice.
 */
async function queueWarrantyEmail(firestore, warranty, logger) {
    if (!HERO_EMAIL_ENABLED || !warranty || !warranty.pdfPath || warranty.emailedAt) return false;
    const to = String(warranty.customerEmail || '').trim();
    if (!to) {
        logger.warn('warranty certificate: no email address on file', { registrationId: warranty.registrationId });
        return false;
    }
    try {
        const url = await signedUrl(warranty.pdfPath);
        const testReportUrl = warranty.testReport && warranty.testReport.pdfPath ? await signedUrl(warranty.testReport.pdfPath) : '';
        const extras = await extrasForMail(warranty.extras);
        // The customer's Super Hero certificate, when they have one (2026-10-27).
        let hero = null;
        try {
            const h = await firestore.collection(HERO_COLLECTION).doc(String(warranty.uid || '')).get();
            const d = h.exists ? h.data() || {} : null;
            if (d && d.status === 'ready' && d.pdfPath) {
                hero = {
                    number: String(d.certificateNumber || ''),
                    pngUrl: d.pngPath ? await signedUrl(d.pngPath) : '',
                    pdfUrl: await signedUrl(d.pdfPath),
                };
            }
        } catch (error) {
            logger.warn('warranty email: could not attach the hero certificate', { error: String(error && error.message ? error.message : error) });
        }
        const mailRef = await firestore.collection(MAIL_COLLECTION).add({
            ...buildWarrantyMailDocument({
                to,
                customerName: warranty.customerName,
                serialnumber: warranty.serialnumber,
                url,
                filename: warrantyFilename(warranty.serialnumber),
                testReportUrl,
                testReportFilename: testReportFilename(warranty.serialnumber),
                extras,
                hero,
            }),
            warrantyRegistrationId: warranty.registrationId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        await markEmailed(firestore, warranty.registrationId);
        for (const e of extras) await markEmailed(firestore, e.registrationId);
        const sent = await mailer.sendQueued(mailRef.id);
        if (!sent.sent && sent.reason === 'error') {
            logger.warn('warranty certificate: the email failed to send', {
                registrationId: warranty.registrationId,
                mailDocId: mailRef.id,
                error: sent.error,
            });
        }
        return true;
    } catch (error) {
        logger.error('warranty certificate: could not queue the email', {
            registrationId: warranty.registrationId,
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

module.exports = { issueForUser, queueEmail, queueWarrantyEmail, uidFromRegistration, millisOf };
