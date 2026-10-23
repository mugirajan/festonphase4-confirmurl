'use strict';

/**
 * The factory test report, rendered server-side (2026-10-23) so it can ride in
 * the certificate email with the warranty and the Solar Super Hero certificate.
 *
 * The app and the portal draw the same document on the device; this is the
 * same content — Feston's QC checklist, fixed results, only the header varies
 * per product — as HTML for Chrome, A4 portrait, stored next to the warranty
 * certificate (`test-reports/{uid}/{registrationId}.pdf`, `test_reports/{id}`).
 */

const admin = require('firebase-admin');
const { TEST_REPORT_COLLECTION, TEST_REPORT_STORAGE_PREFIX } = require('./config');
const { PAGE, familyOf } = require('./warranty-certificate');

const str = (v) => (typeof v === 'string' ? v.trim() : '');

const MANUFACTURER = 'FESTON SEV';
const AMBIENT_TEMP = '25°C';

/** AC voltage trip limits — the only thing that varies with phase. */
const VOLTAGE_LIMITS = {
    single: { over: '>280', under: '<170' },
    three: { over: '>460', under: '<320' },
};

function ongridItems(v) {
    return [
        { item: 'Hi-pot', spec: 'DC 3000V <10MA' },
        { item: 'Lightning performance test', spec: '' },
        { item: 'Check SN', spec: '' },
        { item: 'F/W  COM', spec: '' },
        { item: 'F/W  MCU', spec: '' },
        { item: 'Vpv(V) Accuracy', spec: '<2%' },
        { item: 'Ipv(A) Accuracy', spec: '<3%' },
        { item: 'Ppv(W) Accuracy', spec: '<2%' },
        { item: 'Vac(V) Accuracy', spec: '<2%' },
        { item: 'Fac(Hz) Accuracy', spec: '<0.1%' },
        { item: 'Iac(A) Accuracy', spec: '<3%' },
        { item: 'Pac(W) Accuracy', spec: '<2%' },
        { item: 'Efficiency(%)', spec: '>96' },
        { item: 'Power Factor', spec: '>0.99' },
        { item: 'THDI(%)', spec: '<3' },
        { item: 'Anti-islanding detection', spec: '' },
        { item: 'Over-frequent test(Hz)', spec: '>51.5' },
        { item: 'Under-frequent test(Hz)', spec: '<47.5' },
        { item: 'Over voltage test(V)', spec: v.over },
        { item: 'Under voltage test(V)', spec: v.under },
        { item: 'LCD Display Check', spec: '' },
        { item: 'Factory Reset', spec: '' },
        { item: 'Air Flow test', spec: '', checkbox: true },
        { item: 'Appearance Check', spec: '', checkbox: true },
        { item: 'Accessories Check', spec: '', checkbox: true },
    ];
}

function hybridItems(v) {
    return [
        { item: 'Hi-pot', spec: 'DC 3000V <10MA' },
        { item: 'Check SN', spec: '' },
        { item: 'Vbatt(V)Accuracy (%)', spec: '<0.5%' },
        { item: 'Ibatt(A)Accuracy (%)', spec: '<3%' },
        { item: 'Vpv(V)Accuracy (%)', spec: '<3%' },
        { item: 'Ipv(A)Accuracy (%)', spec: '<3%' },
        { item: 'Ppv(W)Accuracy (%)', spec: '<3%' },
        { item: 'Vac(V)Accuracy (%)', spec: '<3%' },
        { item: 'Fac(Hz)Accuracy (%)', spec: '<0.1%' },
        { item: 'Iac(A)Accuracy (%)', spec: '<3%' },
        { item: 'Pac(W)Accuracy (%)', spec: '<3%' },
        { item: 'Efficiency (%)', spec: '>96' },
        { item: 'Power Factor', spec: '>0.99' },
        { item: 'THDI (%)', spec: '<3%' },
        { item: 'Over-frequent test (Hz)', spec: '>51.5' },
        { item: 'Under-frequent test(Hz)', spec: '<47.5' },
        { item: 'Over voltage test(V)', spec: v.over },
        { item: 'Under voltage test(V)', spec: v.under },
        { item: 'Anti-islanding detection', spec: '' },
        { item: 'Factory Reset', spec: '' },
        { item: 'Air Flow test', spec: '', checkbox: true },
        { item: 'Appearance Check', spec: '', checkbox: true },
        { item: 'LCD Display Check', spec: '', checkbox: true },
    ];
}

function batteryItems() {
    return [
        'Visual Inspection', 'Torque Marking Check', 'Battery Voltage', 'Open Circuit Voltage', 'Capacity Test',
        'Charge Current Test', 'Discharge Current Test', 'Cell Voltage Difference', 'SOC Verification',
        'BMS Communication Check', 'BMS Protection Parameter Check', 'Firmware Version Check', 'LED Indicator Check',
        'Insulation Resistance Test', 'Inverter Communication Test', 'Final Pass/Fail', 'Factory Reset', 'Appearance Check',
    ].map((item) => ({ item, spec: '' }));
}

/** 'three' for a 3-phase unit, else 'single'. Reads the row's `phase` in any of its stored shapes. */
function phaseOf(row) {
    const p = String(row.phase ?? row.Phase ?? '').trim().toLowerCase();
    return p === '3' || p.startsWith('three') || p === '3p' || p === 'three phase' ? 'three' : 'single';
}

function phaseDisplay(phase) {
    return phase === 'three' ? 'Three Phase' : 'Single Phase';
}

function testReportFor(family, phase) {
    const v = phase === 'three' ? VOLTAGE_LIMITS.three : VOLTAGE_LIMITS.single;
    if (family === 'batteries') return { headers: { item: 'Test item', spec: '', result: 'Result' }, items: batteryItems() };
    if (family === 'hybrid') return { headers: { item: 'Test item', spec: 'Standard', result: 'Result' }, items: hybridItems(v) };
    return { headers: { item: 'Test item', spec: 'Specifications', result: 'Test Result' }, items: ongridItems(v) };
}

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) =>
        ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
    );
}

/** The report for a registration row — the portal's layout, as a page for Chrome. */
function testReportHtml(row, certificateNumber = '') {
    const family = familyOf(row) || 'ongrid';
    const phase = phaseOf(row);
    const report = testReportFor(family, phase);
    const serial = str(row.serialnumber) || str(row.Serialnumber) || '-';
    const model = str(row.inverterModel) || str(row.model) || str(row.name) || '-';
    const showPhase = family !== 'batteries';

    const rows = report.items
        .map(
            (t, i) => `
        <tr class="${i % 2 === 0 ? 'even' : 'odd'}">
          <td class="item">${escapeHtml(t.item)}</td>
          <td class="spec">${escapeHtml(t.spec)}</td>
          <td class="res">${t.checkbox ? '<span class="box on"></span> Pass&nbsp;&nbsp;/&nbsp;&nbsp;<span class="box"></span> Fail' : 'Pass'}</td>
        </tr>`,
        )
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Test Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Roboto, -apple-system, Arial, sans-serif; background: #fff; color: #111; }
  .page { width: ${PAGE.width}px; height: ${PAGE.height}px; padding: 32px; position: relative; }
  .frame { border: 1.5px solid #333; height: 100%; padding: 22px 32px; position: relative; }
  h1 { text-align: center; font-size: 34px; font-weight: 400; margin-bottom: 16px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; }
  .head .left p { font-size: 15px; line-height: 24px; }
  .head .left b { font-weight: 700; }
  .head .right { text-align: right; }
  .serial { display: inline-block; border: 1.5px solid #333; padding: 5px 18px; font-size: 16px; font-weight: 700; min-width: 210px; text-align: center; }
  .phase { font-size: 15px; font-weight: 700; margin-top: 10px; }
  hr { border: 0; border-top: 1px solid #999; margin: 12px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 14px; font-weight: 700; padding: 4px 4px 6px; border-bottom: 1.6px solid #333; }
  th.item { text-align: left; padding-left: 14px; width: 48%; }
  th.spec, th.res { text-align: center; }
  td { font-size: 12.5px; padding: 3px 4px; height: 23px; }
  td.item { padding-left: 14px; }
  td.spec, td.res { text-align: center; }
  tr.even td { background: #f2f2f2; }
  .box { display: inline-block; width: 9px; height: 9px; border: 1px solid #111; vertical-align: middle; margin-right: 3px; }
  .box.on { background: #111; }
  .foot { position: absolute; left: 32px; right: 32px; bottom: 26px; display: flex; align-items: center; justify-content: space-between; }
  .seals { display: flex; gap: 22px; }
  .seal { width: 92px; height: 92px; border-radius: 50%; border: 3px solid; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 12px; font-weight: 700; line-height: 1.2; letter-spacing: .5px; transform: rotate(-12deg); }
  .seal.blue { color: #055CA7; border-color: #055CA7; box-shadow: inset 0 0 0 3px #fff, inset 0 0 0 4.5px #055CA7; }
  .seal.green { color: #1e8e3e; border-color: #1e8e3e; box-shadow: inset 0 0 0 3px #fff, inset 0 0 0 4.5px #1e8e3e; width: 88px; height: 88px; }
  .result { font-size: 24px; font-weight: 700; }
</style>
</head>
<body>
  <div class="page"><div class="frame">
    <h1>Test Report</h1>
    <div class="head">
      <div class="left">
        <p>Manufacturer: ${escapeHtml(MANUFACTURER)}</p>
        <p>Model: <b>${escapeHtml(model)}</b></p>
        <p>Ambient temperature: ${escapeHtml(AMBIENT_TEMP)}</p>
        ${certificateNumber ? `<p>Certificate No: ${escapeHtml(certificateNumber)}</p>` : ''}
      </div>
      <div class="right">
        <div class="serial">${escapeHtml(serial)}</div>
        ${showPhase ? `<div class="phase">Phase: ${escapeHtml(phaseDisplay(phase))}</div>` : ''}
      </div>
    </div>
    <hr />
    <table>
      <thead><tr>
        <th class="item">${escapeHtml(report.headers.item)}</th>
        <th class="spec">${escapeHtml(report.headers.spec)}</th>
        <th class="res">${escapeHtml(report.headers.result)}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="foot">
      <div class="seals">
        <div class="seal blue">FESTON<br/>S.E.V</div>
        <div class="seal green">QUALITY<br/>APPROVED</div>
      </div>
      <div class="result">Result: PASS</div>
    </div>
  </div></div>
</body>
</html>`;
}

function storagePath(uid, registrationId, ext) {
    return `${TEST_REPORT_STORAGE_PREFIX}/${uid || 'unknown'}/${registrationId}.${ext}`;
}

/** The attachment file name the customer sees, e.g. "Test-Report-2209040029.pdf". */
function testReportFilename(serialnumber) {
    const safe = String(serialnumber || '').replace(/[^A-Za-z0-9-]/g, '');
    return `Test-Report-${safe || 'report'}.pdf`;
}

/**
 * Renders and stores the test report for a registration, once. Same shape
 * and deps as `issueWarranty`; a second call returns the stored record.
 */
async function issueTestReport(firestore, registrationId, row, deps) {
    const ref = firestore.collection(TEST_REPORT_COLLECTION).doc(registrationId);
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : null;
    if (existing && existing.status === 'ready' && existing.pdfPath) {
        return { id: registrationId, ...existing };
    }

    const uid = str(row.userId);
    const files = await deps.renderLayout(testReportHtml(row), { ...PAGE, png: false });
    const pdfPath = storagePath(uid, registrationId, 'pdf');
    await deps
        .bucket()
        .file(pdfPath)
        .save(files.pdf, {
            resumable: false,
            contentType: 'application/pdf',
            metadata: { cacheControl: 'private, max-age=0, must-revalidate, no-transform' },
        });

    const record = {
        status: 'ready',
        registrationId,
        uid,
        serialnumber: str(row.serialnumber) || str(row.Serialnumber),
        customerName: str(row.customerName),
        customerEmail: str(row.customerEmail),
        family: familyOf(row) || '',
        pdfPath,
        issuedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await ref.set(record, { merge: true });
    return { id: registrationId, ...record };
}

module.exports = { testReportFor, testReportHtml, issueTestReport, testReportFilename, phaseOf, storagePath };
