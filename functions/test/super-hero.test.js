'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    issueSuperHero,
    nextSequenceNo,
    queueSuperHeroEmail,
    escapeHtml,
    AWARD_NAME,
    CERTIFICATES,
    MAIL_QUEUE,
} = require('../lib/super-hero');

/**
 * A Firestore stub recording what was written, per collection.
 *
 * Deliberately not a mock library: the thing under test writes two documents
 * and increments a counter, and the assertions are about WHAT was written.
 */
function fakeStore(counterValue) {
    const writes = { [CERTIFICATES]: [], [MAIL_QUEUE]: [], counters: [] };
    const firestore = {
        collection(name) {
            return {
                doc(id) {
                    return { id: id || `${name}-doc-1`, __collection: name };
                },
            };
        },
    };
    const tx = {
        async get(ref) {
            if (counterValue === undefined) return { exists: false };
            return { exists: true, data: () => ({ value: counterValue }) };
        },
        set(ref, data) {
            const bucket = writes[ref.__collection] || (writes[ref.__collection] = []);
            bucket.push(data);
        },
    };
    return { firestore, tx, writes };
}

const registration = (over = {}) => ({
    id: 'reg-1',
    userId: 'uid-1',
    customerName: 'Asha Rao',
    customerEmail: 'asha@example.com',
    serialnumber: 'SN123',
    installationDate: '2026-08-25',
    capacityKw: 5,
    ...over,
});

test('the first certificate is FSSH-00001', async () => {
    const { firestore, tx } = fakeStore(undefined);
    assert.strictEqual(await nextSequenceNo(tx, firestore), 'FSSH-00001');
});

test('the sequence continues from the counter, zero-padded to five', async () => {
    const { firestore, tx } = fakeStore(41);
    assert.strictEqual(await nextSequenceNo(tx, firestore), 'FSSH-00042');

    const big = fakeStore(99999);
    assert.strictEqual(await nextSequenceNo(big.tx, big.firestore), 'FSSH-100000');
});

test('EVERY system size earns it — there is no kW threshold', async () => {
    // The rule this feature exists for. A 0.5kW rooftop is the same step
    // towards clean energy as a 500kW farm; a recognition that scaled with kW
    // would be a sales league table. If someone ever adds a threshold, this is
    // the test that should stop them.
    for (const capacityKw of [0, 0.5, 1, 5, 50, 500, null, undefined]) {
        const { firestore, tx, writes } = fakeStore(0);
        const cert = await issueSuperHero(tx, firestore, registration({ capacityKw }));

        assert.strictEqual(writes[CERTIFICATES].length, 1, `no certificate for ${capacityKw}kW`);
        assert.strictEqual(cert.award, AWARD_NAME);
        assert.strictEqual(cert.sequenceNo, 'FSSH-00001');
    }
});

test('the certificate records who it belongs to', async () => {
    const { firestore, tx, writes } = fakeStore(0);
    await issueSuperHero(tx, firestore, registration());

    const rec = writes[CERTIFICATES][0];
    assert.strictEqual(rec.registrationId, 'reg-1');
    assert.strictEqual(rec.userId, 'uid-1');
    assert.strictEqual(rec.customerName, 'Asha Rao');
    assert.strictEqual(rec.customerEmail, 'asha@example.com');
    assert.strictEqual(rec.serialnumber, 'SN123');
    assert.strictEqual(rec.award, AWARD_NAME);
});

test('an email is queued, addressed to the customer', async () => {
    const { firestore, tx, writes } = fakeStore(0);
    await issueSuperHero(tx, firestore, registration());

    assert.strictEqual(writes[MAIL_QUEUE].length, 1);
    const mail = writes[MAIL_QUEUE][0];
    assert.strictEqual(mail.to, 'asha@example.com');
    assert.match(mail.message.subject, /Solar Super Hero/);
    assert.match(mail.message.subject, /FSSH-00001/);
    // Both parts, because a text-only client must still be able to read it.
    assert.match(mail.message.text, /FSSH-00001/);
    assert.match(mail.message.html, /FSSH-00001/);
    assert.match(mail.message.text, /Asha Rao/);
});

test('no email address means no queued mail, and still a certificate', async () => {
    // An installer can register for a customer who gave only a phone number.
    // That customer has still earned the certificate; there is simply nowhere
    // to send it. Failing the registration over it would be absurd.
    for (const customerEmail of ['', '   ', null, undefined]) {
        const { firestore, tx, writes } = fakeStore(0);
        await issueSuperHero(tx, firestore, registration({ customerEmail }));

        assert.strictEqual(writes[CERTIFICATES].length, 1);
        assert.strictEqual(writes[MAIL_QUEUE].length, 0, `queued mail for ${JSON.stringify(customerEmail)}`);
    }
});

test('a nameless customer still reads as a certificate, not a blank', async () => {
    // A registration can genuinely arrive without a name — an installer
    // registering for someone who gave only a phone number. "This is awarded to
    // ," is not shippable, and neither is the old greeting-style fallback:
    // "This is awarded to there," is nonsense on a certificate.
    for (const customerName of ['', '   ']) {
        const { firestore, tx, writes } = fakeStore(0);
        await issueSuperHero(tx, firestore, registration({ customerName }));

        const msg = writes[MAIL_QUEUE][0].message;
        assert.match(msg.text, /This is awarded to you,/);
        assert.ok(!/awarded to\s*,/.test(msg.text), 'left a dangling comma where the name should be');
        assert.ok(!/there,/.test(msg.text), 'used the old greeting fallback on a certificate');
        assert.match(msg.html, />\s*you\s*</);
    }
});

test('the HTML is built for email clients, not browsers', () => {
    // Outlook renders with Word's engine: no flexbox, no grid, no external
    // stylesheet, and div layouts collapse. These assertions pin the choices
    // that keep the certificate intact there.
    const { firestore, tx, writes } = fakeStore(0);
    return issueSuperHero(tx, firestore, registration()).then(() => {
        const html = writes[MAIL_QUEUE][0].message.html;

        assert.match(html, /<table/, 'no table layout — Outlook will collapse it');
        assert.ok(!/display:\s*flex/i.test(html), 'flexbox does not render in Outlook');
        assert.ok(!/display:\s*grid/i.test(html), 'grid does not render in Outlook');
        assert.ok(!/<link|<style/i.test(html), 'external or block CSS is stripped by many clients');
        // Remote images are blocked by default in most clients, so a logo would
        // usually arrive as a broken box. The wordmark is type.
        assert.ok(!/<img/i.test(html), 'no images — they arrive blocked');
        assert.match(html, /FESTON/, 'lost the wordmark');
    });
});

test('the email escapes a name that would otherwise inject markup', async () => {
    const { firestore, tx, writes } = fakeStore(0);
    await issueSuperHero(tx, firestore, registration({ customerName: '<img src=x onerror=alert(1)>' }));

    const html = writes[MAIL_QUEUE][0].message.html;
    assert.ok(!html.includes('<img src=x onerror'), 'raw markup reached the email body');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('escapeHtml neutralises every character that could break out', () => {
    assert.strictEqual(escapeHtml(`<script>&"'`), '&lt;script&gt;&amp;&quot;&#39;');
    assert.strictEqual(escapeHtml(null), '');
    assert.strictEqual(escapeHtml(undefined), '');
});

test('the queued mail can be traced back to its certificate', async () => {
    const { firestore, tx, writes } = fakeStore(7);
    await issueSuperHero(tx, firestore, registration());

    const mail = writes[MAIL_QUEUE][0];
    assert.strictEqual(mail.sequenceNo, 'FSSH-00008');
    assert.ok(mail.certificateId, 'no certificateId on the queued mail');
});

test('queueSuperHeroEmail is a no-op without an address', () => {
    const { firestore, tx, writes } = fakeStore(0);
    queueSuperHeroEmail(tx, firestore, { customerEmail: '', sequenceNo: 'FSSH-00001' });
    assert.strictEqual(writes[MAIL_QUEUE].length, 0);
});
