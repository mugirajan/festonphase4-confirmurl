# Registration Confirmation — web team's reply to the app→web handoff spec

**For the app team.** Your spec is implemented, with two exceptions called out
below (OTP, and the URL). This document is the contract — where it differs from
the original spec, this one is what the deployed service actually does.

---

## The two answers you asked for

### 1. Link shape — single magic-link token

We took your **simpler variant**. There is no `rid`.

```
{CONFIRM_URL}?t=<token>
```

The token **is** the `pending_registrations` document id. Write the record at
`pending_registrations/{token}` and put the same value in `?t=`.

### 2. `{CONFIRM_URL}`

```
https://feston-prod.web.app/app/register/confirm
```

⚠️ **Not `www.festonsev.com`.** Your spec's example used it, but that name is a
WordPress site on LiteSpeed/PHP, on infrastructure that cannot rewrite to a
Cloud Function. The URL above is the Firebase Hosting domain for the same
`feston-prod` project and works today.

If we later add a Feston-branded subdomain (e.g. `register.festonsev.com`), that
changes this URL and therefore needs an app release. **Tell us before you ship
if you want to wait for the branded domain** — it is a DNS change on our side,
not a code change, and it is much better for a link a customer receives by SMS.
Keep it in remote config rather than hard-coded if you can.

---

## ⚠️ OTP is NOT implemented

Your spec puts an OTP between the review and the write. **It is not built.** No
SMS provider exists in any Feston project, so this was deferred rather than
faked.

**What that means:** the token alone authorises the registration. Anyone holding
the link can complete it — including the installer who generated it. The link is
unguessable and expires, so it is not open to the world, but it **does not prove
the customer saw it**.

If installer-initiated registrations need that proof, we need an SMS provider
(MSG91, Twilio Verify, …) — account, credentials and per-message budget. The
code has the seam ready: OTP drops into `handleConfirm` in `functions/index.js`
before `completeRegistration` is called. Everything downstream already tolerates
being called twice, so adding it changes no other behaviour.

**Nothing about the app's side changes when OTP is added.** The app writes the
same record and opens the same link either way, so you can build against this
now.

---

## Flow as built

```
1. Installer OR customer completes Steps 1-4 in the app.
2. App generates a token, writes pending_registrations/{token}
      { userId = <CUSTOMER uid>, customerPhone, status:"pending", expiresAt, ...payload... }
   and builds the link:   {CONFIRM_URL}?t={token}
3. Link is given to the CUSTOMER and opened in THEIR browser.
4. Web reads pending_registrations/{token}; checks status=="pending" and not expired.
5. Web renders the review from the record.
6. [OTP would go here — not implemented]
7. Customer taps "Confirm and complete registration".
8. Web writes registered_products (userId = doc.userId)
        + serial_num/{serialDocId}.registered = true
        + pending doc status:"completed", registeredProductId
   — all three in ONE transaction.
9. App does nothing. The product appears in the customer's "My Products".
```

---

## The token — requirements

Generate it in the app, from a **CSPRNG**. It is the document id *and* the only
credential, so it is validated on shape before it ever reaches a lookup:

| Rule | Value |
|---|---|
| Alphabet | `A-Z a-z 0-9 _ -` (url-safe) only |
| Length | 22–128 characters |
| Entropy | ≥128 bits |
| Must not | start with `__` (Firestore-reserved) |

**A Firestore auto-id is not acceptable** and is rejected — it is 20 characters,
and under this shape the id is the whole credential rather than half of it.

Recommended: 24 random bytes, base64url → 32 characters.

```kotlin
// Android
val bytes = ByteArray(24).also { SecureRandom().nextBytes(it) }
val token = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
```

```swift
// iOS
var bytes = [UInt8](repeating: 0, count: 24)
_ = SecCopyRandomBytes(kSecRandomDefault, bytes.count, &bytes)
let token = Data(bytes).base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
```

---

## `pending_registrations/{token}` — what the app writes

### Meta

| Field | Type | Required | Notes |
|---|---|---|---|
| `userId` | string | **yes** | the **customer's** uid — becomes `userId` on `registered_products`. **A record without this is refused** (422), because an ownerless registration that had already flipped the serial could never be repaired by the customer. |
| `status` | string | **yes** | must be `"pending"` to be confirmable |
| `expiresAt` | timestamp | **yes** | we suggest +48h. A missing or unreadable value counts as **expired** — this fails closed on purpose. |
| `serialDocId` | string | no | `serial_num/{serialDocId}.registered` is set true. If absent, or the document does not exist, the registration still succeeds and we log a warning — a bad serial reference should not block a customer. |
| `customerPhone` | string | no* | 10-digit national. *Required once OTP lands.* |
| `customerEmail` | string | no | alternative OTP channel |
| `createdAt` | timestamp | no | server time |
| `token` | string | no | redundant with the doc id; harmless if you write it |
| `registeredByInstallerId` / `…Name` / `…Phone` | string | no | installer-initiated only; copied onto the registration |

`registeredProductId` is written by **us** on completion.

### Payload

The **same field set as a `registered_products` document** — we copy it straight
through. Every one is optional; empty fields are simply not shown.

```
serialnumber, family, productFamily, producttype, customerName, customerEmail,
customerContact, customerPhone, customerAddress, customerCity, customerState,
customerCountry, inverterModel, inverterSerial, batterySerial, batteryModel,
batteryDetails, installationDate, installationCompany, installationAddress,
installationCity, installationState, installationCountry, postalCode,
wifiLogger, installerName, installerContact, warrantyEndDate
```

Also rendered if you send them: `capacity`, `Phase`, `submodel` — the review
page shows Capacity and Phase, and they are **not** in the list above, so send
them explicitly if you want them on the page.

Anything not on the allowlist is **not** copied to the registration. Link
machinery (`token`, `status`, `expiresAt`, `serialDocId`) is never copied.

`batteryDetails` may be `null`, `{ purchased: false }`, or:

```jsonc
{ "purchased": true, "brand": "feston", "festonBatteries": ["2401010001", "2401010002"] }
{ "purchased": true, "brand": "other",  "otherBatteries": [{ "brand": "…", "model": "…", "serial": "…" }] }
```

`festonBatteries` accepts bare serial strings (what you store) or `{ sn, model }`
objects (what the portal wizard stores) — either renders. A single battery can
instead be given as flat `batterySerial` / `batteryModel`.

---

## What the app must NOT do

- **Don't write `registered_products`.** We create it. Writing it too produces
  two rows for one product.
- **Don't poll.** There is no status endpoint — it was removed. Watch
  `registered_products` by `userId` if you want to react, or just let "My
  Products" pick it up.
- **Don't reuse a token.** One token, one registration. Re-submitting means a
  new token and a new pending document.
- **Don't run the countdown as truth.** The page shows one; the deadline is
  enforced server-side against the stored `expiresAt`.

---

## Responses from `POST {CONFIRM_URL}?t=<token>`

The page calls this itself — you never do. Listed so the behaviour is on record.

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ status:"completed", alreadyCompleted, registeredProductId }` | registered |
| `404` | `{ status:"not-found" }` | unknown or malformed token |
| `410` | `{ status:"expired" }` | past `expiresAt` |
| `409` | `{ status:"cancelled" }` | `status` was not `pending` |
| `422` | `{ status:"error" }` | record unusable — currently only a missing `userId` |

**Confirming is idempotent.** A double-tap, a retry or a reopened link returns
the id written the first time; exactly one registration is ever created.

---

## What confirming writes

One transaction, three documents:

1. **`registered_products/{auto-id}`** — the payload above, plus
   `userId` (the customer), `createdAt`, `timestamp`, `customerConfirmed: true`,
   `customerConfirmedAt`, `isDetailsCorrect: true`, `unregistered: false`,
   `registrationSource: "mobile-app-confirm-link"`.
   The last five are not in your spec; they exist so the portal treats this row
   the same as one from the registration wizard.
2. **`serial_num/{serialDocId}`** — `registered: true`.
3. **`pending_registrations/{token}`** — `status: "completed"`,
   `registeredProductId`, `completedAt`.

---

## Two things we need on our side before this is live

Both are Firebase Console changes, not code, and are **not done yet**:

1. **Security rules for `pending_registrations`** — the app must be able to
   create documents; **nothing may read them.** The document id is the
   credential, so a client that could read or list this collection could
   enumerate live links and the PII on them. We read via the Admin SDK, which
   bypasses rules.

   ```
   match /pending_registrations/{token} {
     allow create: if request.auth != null;
     allow read, update, delete: if false;
   }
   ```

2. **A TTL policy on `expiresAt`** so abandoned links delete themselves.

---

## Trying it locally

The whole flow runs in memory — no Firebase, no emulator, no network:

```bash
cd festonphase4-confirmurl
npm install
npm start                    # open http://localhost:8080/
npm run dev -- --ttl 1       # one-minute links, to watch the expiry work
```

`/` seeds a pending registration exactly as the app would and redirects to the
customer's link. After confirming, `http://localhost:8080/state` dumps every
document — you can see the registration created, the serial flipped and the
pending record closed out.
