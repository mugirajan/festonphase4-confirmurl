const path = require('path');

/**
 * Keep Chrome INSIDE the function directory.
 *
 * Puppeteer's default cache is `~/.cache/puppeteer`, which is a home directory
 * that does not survive the trip into a Cloud Functions container — the deploy
 * would succeed and then every render would fail at runtime with "Could not
 * find Chrome". Pinning the cache under the source directory means the browser
 * the `gcp-build` step installs is part of what gets deployed.
 */
module.exports = {
    cacheDirectory: path.join(__dirname, '.cache', 'puppeteer'),
};
