'use strict';

/**
 * The local runner (local-live.js) with email switched on for one-time codes.
 *
 *   npm run live:mail                 same options as `npm run live`
 *   npm run live:mail -- --otp
 *
 * local-live.js reads nothing from functions/.env on purpose, so on its own it
 * has no SMTP settings and every emailed code fails with "Email is not set up
 * on this server". This starter copies ONLY the SMTP_* lines of functions/.env
 * into the environment and then runs the same runner, so the company and
 * installer email codes are sent for real.
 *
 * Certificate and warranty emails stay off: they still need --mail.
 */

const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(__dirname, '..');
const envFile = path.join(dir, '.env');

let text = '';
try {
    text = fs.readFileSync(envFile, 'utf8');
} catch {
    console.error(`  ${envFile} not found: no SMTP settings to load.`);
}
for (const line of text.split(/\r?\n/)) {
    const m = /^(SMTP_[A-Z]+)=(.*)$/.exec(line);
    // A value already set in the terminal wins over the file.
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
console.log(
    'mail settings loaded:',
    ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].map((k) => `${k}=${process.env[k] ? 'yes' : 'NO'}`).join(' '),
);

process.chdir(dir);
require('./local-live.js');
