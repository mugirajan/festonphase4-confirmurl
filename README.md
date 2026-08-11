# festonphase4-confirmurl — registration confirmation links

The mobile app no longer registers a product itself. When the form is submitted —
by an installer on a customer's behalf, or by the customer directly — the app
writes a **pending registration** and hands the customer a link. The customer
reviews the details in their own browser and taps confirm, and **this service
creates the registration**.

Standalone by design. It shares no code with `feston/` or `feston-care/`. The one
thing it needs from `feston-care` is a Hosting rewrite (below).

The app-facing contract is [`INTEGRATION.md`](./INTEGRATION.md) — that is the
document to send the app team.

```
 mobile app                  this service                      customer
 ──────────                  ────────────                      ────────
 submit registration
        │
        ├─ write pending_registrations/{token}
        │  (userId, expiresAt, full payload)
        │
        └─ send {CONFIRM_URL}?t={token} ───────────────────────▶ opens link
                                                                     │
                                        renders the details ◀────────┤
                                                                     │
                                        POST ?t={token}      ◀───────┤ taps confirm
                                        ┌──────────── one transaction ───────────┐
                                        │ create registered_products (userId)    │
                                        │ serial_num/{id}.registered = true      │
                                        │ pending → completed + registeredProdId │
                                        └────────────────────────────────────────┘
 does nothing — the product appears in the customer's "My Products"
```

---

## One function, two methods

`{CONFIRM_URL}` is a Hosting path rewritten to this function:
`https://feston-prod.web.app/app/register/confirm`

### `GET ?t=<token>` — the customer's page

Server-rendered HTML. One request, no framework, no external CSS, script or font
— the customer is on a phone, on mobile data, standing next to the installer.

| State | Response |
|---|---|
| live | `200` details + confirm button + countdown |
| already registered | `200` "Registration complete", details, no button |
| expired | `410` "This link has expired", **no personal data** |
| cancelled | `410` "No longer active", **no personal data** |
| unknown token | `404` "Link not found", **no personal data** |

### `POST ?t=<token>` — what the button calls

| Status | Body |
|---|---|
| `200` | `{ status:"completed", alreadyCompleted, registeredProductId }` |
| `404` | `{ status:"not-found" }` |
| `410` | `{ status:"expired" }` |
| `409` | `{ status:"cancelled" }` |
| `422` | `{ status:"error" }` — record unusable (currently: missing `userId`) |

There is **no status endpoint**. The app does not poll; the registration simply
appears under the customer's `userId`.

---

## What confirming writes

One transaction, three documents — because a half-done confirmation is the worst
outcome available. A registration with no serial flipped can be registered twice;
a serial flipped with no registration locks the customer out of ever registering
it.

1. **`registered_products/{auto-id}`** — the allowlisted payload copied from the
   pending record, plus `userId` (**the customer**, never the installer),
   `createdAt`, `timestamp`, `customerConfirmed`, `customerConfirmedAt`,
   `isDetailsCorrect`, `unregistered: false`,
   `registrationSource: "mobile-app-confirm-link"`.
2. **`serial_num/{serialDocId}`** — `registered: true`.
3. **`pending_registrations/{token}`** — `status: "completed"`,
   `registeredProductId`, `completedAt`.

The copy is an **allowlist** (`lib/payload.js`), not a spread: link machinery
(`token`, `status`, `expiresAt`, `serialDocId`) must never land on a registration,
and a client that writes an extra field must not be able to put arbitrary keys on
a row the portal trusts.

---

## Rules worth knowing

- **The expiry is never enforced in the browser.** The countdown is a courtesy;
  the deadline that decides anything is the `expiresAt` the app stored, re-checked
  on page load *and again inside the transaction* — so a link that lapses while
  the page sits open cannot still be confirmed. A missing or unreadable
  `expiresAt` counts as expired. It fails closed, always.
- **Confirming is idempotent.** A double-tap, a retry or a reopened link returns
  the id written the first time. Exactly one registration is ever created.
- **A record with no `userId` is refused**, not half-written. An ownerless
  registration whose serial had already been flipped could never be repaired by
  the customer; refusing leaves the link usable once the record is fixed.
- **A missing `serial_num` document does not block the customer.** The
  registration is created and a warning is logged.
- **Tokens are shape-checked** before being used as a document id — scanning
  traffic costs a 404, not a Firestore read. A Firestore auto-id is rejected: at
  20 characters it is too short to be the sole credential.
- **Expired, cancelled and unknown links render no personal data.**
- **Every customer-supplied string is HTML-escaped.** The details are typed into
  a mobile form and stored verbatim; this page treats them as untrusted.
- **No page is cached** (`no-store, private`) and none is indexable.

---

## Running it

```bash
npm install
npm start        # then open http://localhost:8080/
```

The code lives in `functions/`, the standard Firebase layout. The root
`package.json` forwards every command there, so these work from **either** folder
— `npm install` at the root installs the dependencies in `functions/` too.

### See the whole flow in a browser

Opening `/` seeds a pending registration exactly as the app would and redirects
you to the customer's link.

```bash
npm start                        # 48-hour links, like production
npm run dev -- --ttl 1           # one-minute links, to watch the expiry work
```

After confirming, `http://localhost:8080/state` dumps every document — the
registration created, the serial flipped, the pending record closed out.

To see the expiry: open a one-minute link, wait, reload. The countdown runs out,
the details disappear and the page returns 410.

This runs the real handler with Firestore held in memory — no emulator, no Java,
no network, and `feston-prod` is never touched. Restarting wipes everything.

### The other commands

```bash
npm test         # 59 tests — Firebase stubbed in-memory, no network
npm run preview  # each page state written to functions/preview/*.html
npm run deploy   # firebase deploy --only functions:confirm
```

`npm run preview` is for checking the design only; its confirm button posts to a
placeholder and will fail. Use `npm run dev` to exercise the flow.

### Deploy

From the project folder, the one holding `firebase.json` — `.firebaserc` already
points at `feston-prod`:

```bash
firebase deploy --only functions:confirm
```

`confirm` is this project's **codebase** name, declared in `firebase.json`. It is
separate from `feston-care`'s `default` and `hubspot_functions` codebases, so
deploying from here cannot touch, replace or delete anything they own. It deploys
no hosting and no rules.

**Deploy the function before the Hosting rewrite** — a rewrite pointing at a
function that does not exist yet will fail.

### Settings

All optional — see `functions/.env.example`.

| Variable | Default | Why you would set it |
|---|---|---|
| `CONFIRM_PUBLIC_BASE_URL` | `https://feston-prod.web.app/app/register/confirm` | a Feston-branded domain (below) |
| `CONFIRM_LOGO_URL` | unset — renders a "FESTON" wordmark | show the real logo |
| `CONFIRM_TTL_MINUTES` | `2880` (48h) | dev server and docs only — the app sets the real deadline |

---

## The URL, and why it is not `www.festonsev.com`

The handoff spec's example was `https://www.festonsev.com/app/register/confirm`.
**That cannot work.** `www.festonsev.com` is a WordPress site on LiteSpeed/PHP,
on infrastructure with no route to a Cloud Function.

The working URL is the Firebase Hosting domain of the same `feston-prod` project,
served by a rewrite **added to `feston-care/firebase.json`** (the config that owns
Hosting for the project):

```jsonc
"rewrites": [
  { "source": "/app/register/confirm", "function": "confirm", "region": "us-central1" },
  { "source": "**", "destination": "/index.html" }   // keep this last
]
```

Order matters — the catch-all must stay last or it swallows the confirm path.

**For a Feston-branded link**, add a subdomain such as `register.festonsev.com` to
Firebase Hosting (a DNS record at the registrar plus a custom domain in the
console), then set `CONFIRM_PUBLIC_BASE_URL` to it. Do this **before the app
ships** — changing the URL afterwards means an app release.

---

## Before this goes in front of real customers

1. **OTP is not implemented.** The handoff spec puts a phone verification between
   the review and the write; no SMS provider exists in any Feston project, so it
   was deferred rather than faked. **Consequence:** the token alone authorises the
   registration, so anyone holding the link — including the installer who
   generated it — can complete it. The link is unguessable and expires, but it
   does not *prove the customer saw it*. The seam is in `handleConfirm`
   (`functions/index.js`): verify, then call `completeRegistration`.

2. **Firestore rules for `pending_registrations` are not deployed.** The app must
   be able to create documents; **nothing may read them.** The document id is the
   credential, so a client that could read or list the collection could enumerate
   live links and the PII on them. This repo has no `firestore.rules` (consistent
   with `feston-care`, whose live rules exist only in the Firebase Console). Add
   there, alongside the existing blocks:

   ```
   match /pending_registrations/{token} {
     allow create: if request.auth != null;
     allow read, update, delete: if false;   // Admin SDK is unaffected
   }
   ```

3. **No TTL policy yet.** Abandoned links should delete themselves — enable a
   Firestore TTL policy on `pending_registrations.expiresAt`. Without it the
   collection grows and holds PII indefinitely.

4. **There is no rate limit.** Token entropy makes guessing impractical, so this
   is a cost and noise concern rather than an exposure one. App Check or Cloud
   Armor in front of the function is the tidy follow-up.
