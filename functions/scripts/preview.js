'use strict';

/**
 * Renders each page state to ./preview/*.html so the design can be checked in a
 * browser without deploying anything or touching Firestore.
 *
 *   npm run preview      then open functions/preview/pending.html
 *
 * The confirm button in the preview will fail — it posts to a placeholder URL.
 * That is the point: this previews the page, not the flow.
 */

const fs = require('fs');
const path = require('path');

const { renderPendingPage, renderConfirmedPage, renderUnavailablePage } = require('../lib/page');
const { buildDetailsFromRegistration } = require('../lib/snapshot');

const SAMPLE = buildDetailsFromRegistration({
    customerName: 'Raju Krishnan',
    customerPhone: '9043730533',
    customerEmail: 'raju.k@example.com',
    customerAddress: '12 Anna Salai, Guindy, Chennai, Tamil Nadu, India',
    Serialnumber: '2505063529',
    productFamily: 'hybrid',
    modelnumber: 'FE-5.0-3P-HY',
    capacity: '5.0',
    Phase: '3',
    installerName: 'Muthu Kumar',
    installerContact: '9876543210',
    installationCompany: 'Rppl Solar Solutions',
    installationDate: '2026-05-30',
    installationAddressFull: '12 Anna Salai, Guindy, Chennai, Tamil Nadu, India',
    installationPostalCode: '600032',
    wifiLogger: 'WL-88213004',
    warrantyEndDate: '2036-05-30',
    batteryDetails: {
        purchased: true,
        brand: 'feston',
        festonBatteries: [
            { sn: '2401010001', model: 'FB-5.1' },
            { sn: '2401010002', model: 'FB-5.1' },
        ],
    },
});

const outDir = path.join(__dirname, '..', 'preview');
fs.mkdirSync(outDir, { recursive: true });

const pages = {
    'pending.html': renderPendingPage({
        details: SAMPLE,
        expiresAt: Date.now() + 48 * 60 * 60 * 1000,
        actionUrl: 'https://example.invalid/app/register/confirm?t=PREVIEW',
        token: 'PREVIEW',
        logoUrl: '',
    }),
    'confirmed.html': renderConfirmedPage({ details: SAMPLE, logoUrl: '' }),
    'expired.html': renderUnavailablePage({ reason: 'expired', logoUrl: '' }),
    'cancelled.html': renderUnavailablePage({ reason: 'cancelled', logoUrl: '' }),
    'not-found.html': renderUnavailablePage({ reason: 'not-found', logoUrl: '' }),
};

for (const [name, html] of Object.entries(pages)) {
    fs.writeFileSync(path.join(outDir, name), html, 'utf8');
    console.log('wrote', path.join('preview', name));
}
