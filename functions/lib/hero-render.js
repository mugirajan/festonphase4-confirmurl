'use strict';

/**
 * Rendering the certificate to the files a customer actually receives.
 *
 * One headless Chrome, two outputs from the SAME page: a PNG for sharing and a
 * PDF for keeping. Rendering both from one navigation is not just an
 * optimisation — it is what guarantees the image someone posts to WhatsApp and
 * the document they print are the same certificate, down to the glyph.
 *
 * Why render server-side at all, when the app could show the HTML in a WebView:
 * the email has to carry the certificate as an attachment, the admin portal has
 * to show the same artefact, and the app has to hand a real file to the OS share
 * sheet. Rendering once, centrally, means those three never drift.
 *
 * The browser is held across invocations. A cold start pays ~1-2s to launch
 * Chrome; a warm instance issuing the next customer's certificate should not pay
 * it again.
 */

const puppeteer = require('puppeteer');

/** A4 landscape at 96 dpi — the size the artwork is laid out at. */
const PAGE_WIDTH = 1123;
const PAGE_HEIGHT = 794;

/**
 * 2x. The design was delivered as `Main@2x.png` at 2246x1588 and that is the
 * density it was judged at; a 1x share image looks soft the moment anyone
 * pinch-zooms it in WhatsApp.
 */
const SCALE = 2;

let browserPromise = null;

/**
 * Chrome flags for a container with no display, no GPU and a small /dev/shm.
 *
 * `--no-sandbox` is required because Cloud Functions already runs the process
 * in a locked-down gVisor sandbox and Chrome's own sandbox cannot nest inside
 * it. The content being rendered is our own template with our own data, not
 * anything a visitor supplied.
 */
const LAUNCH_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    // The default 64MB /dev/shm in a container makes Chrome crash on larger
    // pages; this makes it use /tmp instead.
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--font-render-hinting=none',
];

function launchOptions() {
    const options = { args: LAUNCH_ARGS, headless: true };
    // Local development uses the machine's own Chrome; the deployed function
    // uses the copy the `gcp-build` step installs into the container.
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    return options;
}

async function getBrowser() {
    if (!browserPromise) {
        browserPromise = puppeteer.launch(launchOptions()).catch((err) => {
            // Never cache a failed launch — the next invocation must retry.
            browserPromise = null;
            throw err;
        });
    }
    const browser = await browserPromise;
    if (!browser.connected) {
        browserPromise = null;
        return getBrowser();
    }
    return browser;
}

/** Releases the shared browser. Used by tests and by graceful shutdown. */
async function closeBrowser() {
    const pending = browserPromise;
    browserPromise = null;
    if (!pending) return;
    try {
        const browser = await pending;
        await browser.close();
    } catch {
        // Already gone. Nothing to release.
    }
}

/**
 * Renders certificate HTML to `{ png, pdf }` Buffers.
 *
 * `setContent` with `waitUntil: 'load'` is enough because the page has no
 * network dependencies at all — every font and image is a data URI. The
 * explicit wait on `document.fonts.ready` is the one that matters: without it
 * Chrome will happily screenshot the page with fallback metrics and the
 * customer's name comes out in Segoe UI.
 */
async function renderCertificate(html) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setViewport({
            width: PAGE_WIDTH,
            height: PAGE_HEIGHT,
            deviceScaleFactor: SCALE,
        });
        await page.setContent(html, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);

        const png = await page.screenshot({
            type: 'png',
            clip: { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT },
        });

        const pdf = await page.pdf({
            width: `${PAGE_WIDTH}px`,
            height: `${PAGE_HEIGHT}px`,
            printBackground: true,
            pageRanges: '1',
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
        });

        return { png: Buffer.from(png), pdf: Buffer.from(pdf) };
    } finally {
        await page.close().catch(() => {});
    }
}

module.exports = {
    PAGE_WIDTH,
    PAGE_HEIGHT,
    SCALE,
    LAUNCH_ARGS,
    getBrowser,
    closeBrowser,
    renderCertificate,
};
