'use strict';

/**
 * The Feston wordmark at the top of every email the service sends
 * (2026-10-27): the certificate emails and the password reset.
 *
 * Travels as an INLINE attachment referenced by `cid:`, not as a remote
 * image. Mail clients block remote images until the reader allows them, so a
 * hosted logo shows as a grey box to most people on first open; an inline
 * part shows at once, everywhere, offline included. The bytes are the same
 * 600×223 wordmark the confirm page embeds (lib/brand.js), base64 in the
 * queued mail document — about 48 KB, well inside Firestore's 1 MiB cap.
 * nodemailer and the Trigger Email extension both accept this shape.
 */

const { FESTON_WORDMARK_DATA_URI } = require('./brand');

const LOGO_CID = 'feston-logo';
const LOGO_BASE64 = FESTON_WORDMARK_DATA_URI.replace(/^data:image\/png;base64,/, '');

/** The attachment to add to `message.attachments`. */
function logoAttachment() {
    return {
        filename: 'feston-logo.png',
        content: LOGO_BASE64,
        encoding: 'base64',
        contentType: 'image/png',
        cid: LOGO_CID,
        contentDisposition: 'inline',
    };
}

/** The `<img>` for the top of the HTML body; `alt` carries the name where images are off. */
function logoHtml() {
    return `<p style="margin:0 0 24px;"><img src="cid:${LOGO_CID}" width="150" height="56" alt="Feston" style="display:block;width:150px;height:auto;border:0;" /></p>`;
}

/** Everything in `attachments` that is a file for the reader, not the logo. */
function fileAttachments(attachments) {
    return (attachments || []).filter((a) => a && a.cid !== LOGO_CID);
}

module.exports = { LOGO_CID, logoAttachment, logoHtml, fileAttachments };
