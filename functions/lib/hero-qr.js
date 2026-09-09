'use strict';

/**
 * The certificate's QR code.
 *
 * The artwork ships a hard-coded QR pointing at a generic `festonsev.com/verify`.
 * A certificate that says "Verify at ..." and then hands every customer the
 * same code cannot verify anything, so the code is regenerated per certificate
 * with that certificate's own URL in it.
 *
 * Rendered as inline SVG, never a PNG: the QR has to survive being printed at
 * 68px on screen and at whatever size the customer's printer chooses, and it
 * has to stay inside the "no network, no external asset" rule the rest of the
 * page follows.
 */

const QRCode = require('qrcode');

/** The artwork's ink colour — the same navy the body text uses. */
const DARK = '#1D2A3A';

/**
 * Error correction level M (~15%).
 *
 * Not the library default of L. The code sits on a printed certificate that may
 * be photographed at an angle, folded, or scanned off a phone screen, and M
 * buys real tolerance for a handful of extra modules at this physical size. H
 * would be tougher still but pushes the module count up enough to hurt
 * legibility in a 68px box.
 */
const ERROR_CORRECTION = 'M';

/**
 * Builds the QR as an SVG element string, sized to fill its container.
 *
 * The library emits a fixed `width`/`height` in pixels plus an XML prolog.
 * Both are stripped: the prolog is invalid inside an HTML body, and the fixed
 * size would ignore the 68px frame the artwork draws around it. The `viewBox`
 * the library computes is kept, so the code scales cleanly to any box.
 */
async function buildQrSvg(url) {
    const text = String(url || '').trim();
    if (!text) throw new Error('hero QR: a verify URL is required');

    const raw = await QRCode.toString(text, {
        type: 'svg',
        errorCorrectionLevel: ERROR_CORRECTION,
        // No quiet zone from the library — the artwork already frames the code
        // in 5px of white padding, and a doubled margin shrinks the modules.
        margin: 0,
        color: { dark: DARK, light: '#0000' },
    });

    return raw
        .replace(/<\?xml[^>]*\?>/i, '')
        .replace(/<!DOCTYPE[^>]*>/i, '')
        .replace(/(<svg\b[^>]*?)\swidth="[^"]*"/i, '$1')
        .replace(/(<svg\b[^>]*?)\sheight="[^"]*"/i, '$1')
        .replace(/<svg\b/i, '<svg width="100%" height="100%"')
        .trim();
}

module.exports = { DARK, ERROR_CORRECTION, buildQrSvg };
