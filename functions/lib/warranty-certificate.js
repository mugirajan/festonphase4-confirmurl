'use strict';

/**
 * The warranty certificate, issued on the server with the Solar Super Hero
 * certificate (2026-10-22).
 *
 * One per REGISTRATION — a product's warranty, not a customer's — where the
 * hero certificate is one per customer. Issued by the same trigger at the same
 * moment and attached to the same email (lib/hero-flow.js).
 *
 * The page is the mobile app's own warranty certificate, ported line for line
 * from feston/src/services/certificate.ts (warrantyFields, hybridCenteredFields,
 * hybridBlockFields, buildWarrantyHtml, buildHybridWarrantyHtml) with the same
 * images (lib/warranty-assets.js). The customer must not be handed a different
 * document by email from the one the app shows them. Change both together.
 *
 * Idempotent: the record in `warranty_certificates/{registrationId}` says the
 * files exist, so the platform's retry re-uses them rather than rendering
 * again, and `emailedAt` on it stops a second email.
 */

const admin = require('firebase-admin');
const { WARRANTY_COLLECTION, WARRANTY_STORAGE_PREFIX } = require('./config');
const { toDateString } = require('./format');
const {
    FESTON_MARK_DATA_URI,
    FESTON_WORDMARK_PNG_BASE64_URI,
    HYBRID_TROPHY_JPG_BASE64_URI,
} = require('./warranty-assets');

const BRAND = '#055CA7';
const GOLD = '#B4964E';
const NAVY = '#0E1E42';

/** The app's warrantyPlan(): the type and site are fixed, the years come from the row. */
const PLAN = {
    years: 10,
    type: 'Standard warranty',
    length: '8 Years Standard +2 Years',
    website: 'www.festonsev.com',
};

/** The "Warranty Length" line for a duration (the app's warrantyLengthText). */
const lengthText = (years) => (years === 10 ? PLAN.length : `${years} Years Standard`);

/**
 * Warranty years (Feston, 2026-10-27; the app's data/warranty.ts):
 *   hybrid HV with a Feston battery 10 · hybrid HV without one 5 ·
 *   hybrid LV 10 · a Feston battery row 5 · on-grid / micro 10.
 * The stamped `warrantyYears` wins; a row from before the stamp is read from
 * the gap between its dates, else from the rule.
 */
function warrantyYearsOf(row) {
    if (typeof row.warrantyYears === 'number' && row.warrantyYears > 0) return row.warrantyYears;
    const start = toDateString(row.installationDate);
    const end = toDateString(row.warrantyEndDate);
    if (start && end) {
        const years = Math.round((Date.parse(end) - Date.parse(start)) / (365.25 * 24 * 3600 * 1000));
        if (years > 0) return years;
    }
    return ruleYearsFor(row);
}

/** The rule alone, from what the row says — used at confirm to stamp a row that has no years. */
function ruleYearsFor(row) {
    const family = familyOf(row);
    if (family === 'batteries') return 5;
    const hv = (str(row.submodel) || str(row.productsubtype)).toUpperCase() === 'HV';
    const b = row.batteryDetails && typeof row.batteryDetails === 'object' ? row.batteryDetails : {};
    const hasFestonBattery = b.purchased === true && str(b.brand) === 'feston';
    return family === 'hybrid' && hv && !hasFestonBattery ? 5 : PLAN.years;
}

/** installationDate + years as a Date, or null when the date does not parse. */
function warrantyEndFor(installationDate, years) {
    const raw = installationDate && typeof installationDate.toDate === 'function' ? installationDate.toDate() : installationDate;
    const d = raw instanceof Date ? new Date(raw.getTime()) : typeof raw === 'string' && raw ? new Date(raw) : null;
    if (!d || Number.isNaN(d.getTime())) return null;
    d.setFullYear(d.getFullYear() + years);
    return d;
}

/** A4 portrait, the size the PDF prints at. */
const PAGE = { width: 794, height: 1123, scale: 2, pdf: true, fitHeight: true };

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) =>
        ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
    );
}

/** The app's familyOf, minus the products-collection lookup a confirmed row never needs. */
function familyOf(row) {
    const pf = str(row.productFamily);
    if (pf) return pf;
    const pt = str(row.producttype).toUpperCase();
    if (pt === 'ONGRID') return 'ongrid';
    if (pt === 'HYBRID') return 'hybrid';
    if (pt === 'MICRO') return 'micro-inverter';
    if (pt.includes('BATT')) return 'batteries';
    return null;
}

/** The app's toBattery: both stored shapes of `batteryDetails`. */
function batteryFrom(v) {
    const b = v && typeof v === 'object' ? v : {};
    const festonBatteries = Array.isArray(b.festonBatteries)
        ? b.festonBatteries.map((x) =>
              typeof x === 'string'
                  ? { serial: x.trim(), model: '' }
                  : { serial: str((x || {}).sn) || str((x || {}).serial), model: str((x || {}).model) },
          )
        : [];
    const others = Array.isArray(b.otherBatteries)
        ? b.otherBatteries.map((o) => ({ serial: str((o || {}).serial), model: str((o || {}).model) }))
        : [];
    return { brand: str(b.brand), festonBatteries, others };
}

/** A registration row in the shape the app's certificate builders read (toRegisteredDetail). */
function detailFrom(row) {
    return {
        serialnumber: str(row.serialnumber) || str(row.Serialnumber),
        family: familyOf(row),
        model: str(row.inverterModel) || str(row.model) || str(row.name),
        warrantyEndDate: toDateString(row.warrantyEndDate),
        warrantyYears: warrantyYearsOf(row),
        customer: {
            name: str(row.customerName),
            email: str(row.customerEmail),
            country: str(row.customerCountry),
        },
        installation: {
            date: toDateString(row.installationDate),
            company: str(row.installationCompany),
            address: str(row.installationAddress),
            city: str(row.installationCity),
            state: str(row.installationState),
            country: str(row.installationCountry),
            postalCode: str(row.postalCode),
            wifiLogger: str(row.wifiLogger),
        },
        battery: batteryFrom(row.batteryDetails),
    };
}

/* ── Fields: the app's warrantyFields / hybrid*Fields ─────────────────────── */

/** One line: address, city, state, PIN code, country (order fixed 2026-10-27). */
function composeAddress(inst) {
    return [inst.address, inst.city, inst.state, inst.postalCode, inst.country]
        .map((s) => (s || '').trim())
        .filter(Boolean)
        .join(', ');
}

const shown = (v) => v || '-';

/** The installation-address row: one combined value, wrapping at normal size when long (2026-10-27). */
const addrClass = (f) => (/^Installation Address/.test(f.label) ? ' addr' : '');


function warrantyFields(d) {
    return [
        { label: 'Country of Registration', value: d.customer.country || d.installation.country },
        { label: 'Date of Installation', value: shown(d.installation.date) },
        { label: 'End Date of Warranty', value: shown(d.warrantyEndDate) },
        { label: 'Installation Company', value: d.installation.company },
        { label: 'Installation Address', value: composeAddress(d.installation) },
        { label: 'Product Model', value: d.model },
        { label: 'Product Serial', value: d.serialnumber },
        { label: 'Wifi Logger', value: d.installation.wifiLogger },
    ];
}

function batteryDisplay(b) {
    const uniq = (xs) => Array.from(new Set(xs.filter(Boolean)));
    const serials = [...b.festonBatteries, ...b.others].map((x) => x.serial).filter(Boolean);
    const models = uniq([...b.festonBatteries, ...b.others].map((x) => x.model));
    return {
        serial: serials.join(', ') || 'NA',
        model: models.join(', ') || (b.brand === 'feston' && serials.length ? 'Feston' : 'NA'),
    };
}

function hybridCenteredFields(d) {
    return [
        { label: 'This Product is registered to:', value: d.customer.name || 'The Registered Owner' },
        { label: 'Country of Registration:', value: d.customer.country || d.installation.country },
        { label: 'Date of Installation:', value: shown(d.installation.date) },
    ];
}

/** The title line above CERTIFICATE, per product (one layout for all, 2026-10-27). */
function titleFor(family) {
    switch (family) {
        case 'hybrid':
            return 'FESTON HYBRID WARRANTY';
        case 'batteries':
            return 'FESTON BATTERY WARRANTY';
        case 'ongrid':
            return 'FESTON ON-GRID WARRANTY';
        case 'micro-inverter':
            return 'FESTON MICRO INVERTER WARRANTY';
        default:
            return 'FESTON WARRANTY';
    }
}

/** The navy pill: the plan and its length, now that the big "N YEARS" headline is gone. */
function pillText(years) {
    return `${PLAN.type} · ${years} years`;
}

/**
 * The field block, per product: an inverter names itself and (hybrid) its
 * batteries and logger; a battery names itself and has no logger.
 */
function hybridBlockFields(d) {
    const head = [
        { label: 'End Date of Warranty:', value: shown(d.warrantyEndDate) },
        { label: 'Installation company:', value: d.installation.company },
        // One row, one line: address, city, state, PIN code, country (2026-10-27).
        { label: 'Installation Address:', value: composeAddress(d.installation) },
    ];
    if (d.family === 'batteries') {
        return [...head, { label: 'Battery Model:', value: d.model }, { label: 'Battery Serial:', value: d.serialnumber }];
    }
    const inverter = [
        { label: 'Inverter Model:', value: d.model },
        { label: 'Inverter Serial:', value: d.serialnumber },
    ];
    const battery = batteryDisplay(d.battery);
    const batteries =
        d.family === 'hybrid'
            ? [
                  { label: 'Battery Serial:', value: battery.serial },
                  { label: 'Battery Model:', value: battery.model },
              ]
            : [];
    return [...head, ...inverter, ...batteries, { label: 'Logger no:', value: d.installation.wifiLogger }];
}

/* ── Pages: the app's HTML, with print overrides appended ────────────────── */

/** For print: a white page, no on-screen card shadow. Appended, so the design above is untouched. */
const PRINT = `
  body { background: #fff !important; padding: 28px 24px !important; }
  .cert, .page { box-shadow: none !important; }`;

function standardHtml(d) {
    const owner = escapeHtml(d.customer.name || 'The Registered Owner');
    const serial = escapeHtml(d.serialnumber || '-');
    const fields = warrantyFields(d)
        .map(
            (f) => `
        <tr>
          <td class="fl">${escapeHtml(f.label)}</td>
          <td class="fv${addrClass(f)}">${escapeHtml(f.value || '-')}</td>
        </tr>`,
        )
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Warranty Certificate</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Roboto, -apple-system, Arial, sans-serif; background: #eef1f5; color: #1a1a1a; padding: 18px; }
  .cert { background: #fff; max-width: 660px; margin: 0 auto; padding: 40px 48px 30px; border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,0.09); }
  .logo { display: block; width: 96px; height: 96px; margin: 0 auto 8px; }
  .word { text-align: center; font-size: 23px; font-weight: 800; letter-spacing: 1px; color: #1a1a1a; }
  .cert-word { text-align: center; font-size: 54px; font-weight: 800; letter-spacing: 1px; color: ${BRAND}; line-height: 1.02; }
  .years { text-align: center; font-size: 54px; font-weight: 800; letter-spacing: 1px; color: #1a1a1a; line-height: 1.1; margin-bottom: 24px; }
  .plan-l { text-align: center; font-size: 16px; font-weight: 700; color: #6b7480; margin-top: 12px; }
  .plan-v { text-align: center; font-size: 18px; font-weight: 600; color: ${BRAND}; margin-top: 2px; }
  .note { text-align: center; font-size: 11px; color: #8a929c; margin-top: 3px; }
  .reg { text-align: center; font-size: 15px; margin-top: 8px; }
  .reg.first { margin-top: 28px; }
  .reg .l { color: #6b7480; }
  .reg .v { color: #1a1a1a; font-weight: 700; margin-left: 5px; }
  table.fields { margin: 26px auto 0; border-collapse: collapse; width: 100%; max-width: 540px; }
  table.fields td { padding: 7px 6px; font-size: 14px; vertical-align: top; line-height: 1.4; }
  td.fl { color: #6b7480; width: 44%; }
  td.fv { color: #1a1a1a; font-weight: 600; }
  td.addr { overflow-wrap: anywhere; word-break: break-word; }
${PRINT}
</style>
</head>
<body>
  <div class="cert">
    <img class="logo" src="${FESTON_MARK_DATA_URI}" alt="Feston" />
    <div class="word">WARRANTY</div>
    <div class="cert-word">CERTIFICATE</div>
    <div class="years">${d.warrantyYears} YEARS</div>

    <div class="plan-l">Warranty Type:</div>
    <div class="plan-v">${escapeHtml(PLAN.type)}</div>
    <div class="plan-l">Warranty Length :</div>
    <div class="plan-v">${escapeHtml(lengthText(d.warrantyYears))}*</div>
    <div class="note">*For full terms and conditions, visit ${escapeHtml(PLAN.website)}</div>

    <div class="reg first"><span class="l">This Product is registered to :</span><span class="v">${owner}</span></div>
    <div class="reg"><span class="l">Serial No :</span><span class="v">${serial}</span></div>

    <table class="fields"><tbody>${fields}</tbody></table>
  </div>
</body>
</html>`;
}

function hybridHtml(d) {
    const serial = escapeHtml(d.serialnumber || '-');
    const centered = hybridCenteredFields(d)
        .map(
            (f) =>
                `<div class="cline"><span class="cl">${escapeHtml(f.label)}</span> <b>${escapeHtml(f.value || '-')}</b></div>`,
        )
        .join('');
    const rows = hybridBlockFields(d)
        .map(
            (f) => `
        <tr>
          <td class="bl">${escapeHtml(f.label)}</td>
          <td class="bv${addrClass(f)}">${escapeHtml(f.value || '-')}</td>
        </tr>`,
        )
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Warranty Certificate</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Roboto, -apple-system, Arial, sans-serif; background: #e9ecf1; color: #1a1a1a; padding: 16px; }
  .page { background: #fff; max-width: 720px; margin: 0 auto; border: 5px solid ${GOLD}; padding: 5px; box-shadow: 0 8px 30px rgba(0,0,0,0.10); }
  .frame { border: 2px solid ${GOLD}; padding: 22px 30px 16px; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; }
  .top .wordmark { width: 150px; height: auto; }
  .top .serial { font-size: 13px; color: #1a1a1a; padding-top: 10px; }
  .top .serial b { font-weight: 700; }
  .hybrid { text-align: center; font-size: 22px; color: #565b61; letter-spacing: 1px; margin-top: 10px; }
  .certw { text-align: center; font-size: 48px; font-weight: 800; letter-spacing: 1px; color: ${BRAND}; line-height: 1.05; }
  .divider { height: 1.5px; background: #b9bcc2; margin: 12px 44px 0; }
  .wtype { display: flex; align-items: center; justify-content: center; gap: 18px; margin-top: 22px; }
  .wtype .lbl { font-size: 18px; color: #565b61; }
  .pill { background: ${NAVY}; color: #fff; font-size: 15px; padding: 9px 26px; border-radius: 6px; }
  .note { text-align: center; font-size: 12px; color: #7c828a; margin-top: 20px; }
  .cline { text-align: center; font-size: 15px; color: #565b61; margin-top: 6px; }
  .cline b { color: #1a1a1a; font-weight: 700; }
  .body { display: flex; align-items: flex-end; margin-top: 24px; }
  table.block { border-collapse: collapse; flex: 1; min-width: 0; }
  table.block td { padding: 5px 4px; font-size: 14px; vertical-align: top; }
  td.bl { color: #565b61; white-space: nowrap; padding-right: 20px; padding-left: 14px; }
  td.bv { color: #1a1a1a; font-weight: 700; overflow-wrap: anywhere; word-break: break-word; }
  td.addr { overflow-wrap: anywhere; word-break: break-word; }
  .trophy { width: 150px; height: auto; margin: 0 6px 4px 8px; flex-shrink: 0; }
${PRINT}
</style>
</head>
<body>
  <div class="page">
    <div class="frame">
      <div class="top">
        <img class="wordmark" src="${FESTON_WORDMARK_PNG_BASE64_URI}" alt="Feston" />
        <div class="serial">Serial No: <b>${serial}</b></div>
      </div>
      <div class="hybrid">${escapeHtml(titleFor(d.family))}</div>
      <div class="certw">CERTIFICATE</div>
      <div class="divider"></div>
      <div class="wtype">
        <span class="lbl">Warranty Type:</span>
        <span class="pill">${escapeHtml(pillText(d.warrantyYears))}</span>
      </div>
      <div class="note">*For full terms and conditions, visit ${escapeHtml(PLAN.website)}</div>
      ${centered}
      <div class="body">
        <table class="block"><tbody>${rows}</tbody></table>
        <img class="trophy" src="${HYBRID_TROPHY_JPG_BASE64_URI}" alt="" />
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * The certificate page for a registration row. One layout for every product
 * since 2026-10-27 — the gold frame the hybrid certificate always had — so a
 * customer's inverter and battery certificates look like one set. The title,
 * the years in the pill and the field block follow the product; standardHtml
 * is kept for reference only.
 */
function warrantyHtml(row) {
    const d = detailFrom(row);
    return hybridHtml(d);
}

/* ── Issuing ──────────────────────────────────────────────────────────────── */

function storagePath(uid, registrationId, ext) {
    return `${WARRANTY_STORAGE_PREFIX}/${uid}/${registrationId}.${ext}`;
}

/**
 * Renders and stores the warranty certificate for one registration, once.
 *
 * Returns the record (`{ pdfPath, pngPath, serialnumber, emailedAt, … }`).
 * `deps` exists for the tests: `renderLayout` (Chrome) and `bucket` (Storage).
 */
async function issueWarranty(firestore, registrationId, row, deps) {
    const ref = firestore.collection(WARRANTY_COLLECTION).doc(registrationId);
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : null;
    if (existing && existing.status === 'ready' && existing.pdfPath) {
        return { id: registrationId, ...existing };
    }

    const uid = str(row.userId);
    const files = await deps.renderLayout(warrantyHtml(row), PAGE);
    const b = deps.bucket();
    const options = (contentType) => ({
        resumable: false,
        contentType,
        metadata: { cacheControl: 'private, max-age=0, must-revalidate, no-transform' },
    });
    const pdfPath = storagePath(uid, registrationId, 'pdf');
    const pngPath = storagePath(uid, registrationId, 'png');
    await Promise.all([
        b.file(pdfPath).save(files.pdf, options('application/pdf')),
        files.png ? b.file(pngPath).save(files.png, options('image/png')) : Promise.resolve(),
    ]);

    const record = {
        status: 'ready',
        registrationId,
        uid,
        serialnumber: str(row.serialnumber) || str(row.Serialnumber),
        customerName: str(row.customerName),
        customerEmail: str(row.customerEmail),
        family: familyOf(row) || '',
        pdfPath,
        ...(files.png ? { pngPath } : {}),
        issuedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await ref.set(record, { merge: true });
    return { id: registrationId, ...record };
}

/** Marks the certificate emailed, so a retry never sends it twice. */
async function markEmailed(firestore, registrationId) {
    await firestore
        .collection(WARRANTY_COLLECTION)
        .doc(registrationId)
        .set({ emailedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

/** The attachment file name the customer sees, e.g. "Warranty-2209040029.pdf". */
function warrantyFilename(serialnumber) {
    const safe = String(serialnumber || '').replace(/[^A-Za-z0-9-]/g, '');
    return `Warranty-${safe || 'certificate'}.pdf`;
}

module.exports = {
    PAGE,
    familyOf,
    PLAN,
    detailFrom,
    warrantyFields,
    hybridBlockFields,
    warrantyYearsOf,
    titleFor,
    pillText,
    ruleYearsFor,
    warrantyEndFor,
    warrantyHtml,
    issueWarranty,
    markEmailed,
    warrantyFilename,
    storagePath,
};
