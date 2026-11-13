# Dashboard settings endpoints

Route group: dashboard
Auth: bearer + store (`authenticate` + `resolveTenant`)

Four settings resources:

| Endpoint | Auth | Purpose |
| -------- | ---- | ------- |
| `GET /api/dashboard/settings/business` | **owner-only** (`requireOwner`) | Read the business profile collected at onboarding |
| `PUT /api/dashboard/settings/business` | **owner-only** (`requireOwner`) | Edit the business profile collected at onboarding |
| `GET /api/dashboard/settings/notifications` | **owner-only** | Read the store's notification preference toggles |
| `PUT /api/dashboard/settings/notifications` | **owner-only** | Update notification preference toggles (partial merge) |
| `GET /api/dashboard/settings/storefront` | **owner-only** | Read the storefront settings (template, hero, accent, WhatsApp, social links) |
| `PUT /api/dashboard/settings/storefront` | **owner-only** | Update storefront settings (partial merge) |
| `POST /api/dashboard/settings/password` | authenticate only (no tenant) | Change the account password |

These are deliberately **not** bundled into `GET /api/dashboard/me`:
`/me` is identity data fetched on every page load; settings are a
separable, mutable resource owned by this module and refetched only on
the Settings screen.

Business-settings and notification writes are rate-limited
(`60_000` window / `300` requests) like the other write-heavy dashboard
groups; the password endpoint is rate-limited as a credential endpoint.

---

## PUT /api/dashboard/settings/business

Same field rules as onboarding: `name` is the store name, `businessType`
is a member of `RETAIL | FOOD_AND_BEVERAGE | FASHION_AND_WEARABLES |
HEALTH_AND_BEAUTY | ELECTRONICS | PROFESSIONAL_SERVICES | AGRICULTURE |
OTHER`, `location` is 2–120 characters, `currency` is
`NGN | USD | GHS | KES | ZAR` (default `NGN`), `businessPhone` is a valid
phone number. All fields are required (full replace, like onboarding).

### Request

Headers:

- `Authorization: Bearer <accessToken>`

Body:

```json
{
  "name": "string — required, 1-80",
  "businessType": "string — required, enum above",
  "location": "string — required, 2-120",
  "currency": "string — optional, enum above, default NGN",
  "businessPhone": "string — required, valid phone"
}
```

### Success response

Status: `200`

```json
{
  "storeId": "019f…",
  "name": "string",
  "businessType": "RETAIL",
  "location": "string",
  "currency": "NGN",
  "businessPhone": "string"
}
```

The response is the persisted store profile after the update. Every
successful update writes a `store.settings.updated` entry to the store
activity log (`dashboard-activity-log.md`).

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `400`  | `VALIDATION_ERROR` | Invalid field values |
| `401`  | `UNAUTHORIZED` | Missing/invalid bearer token |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated staff (not owner) |
| `429`  | `RATE_LIMITED` | — |

---

## GET /api/dashboard/settings/business

Reads the persisted business profile — the read half of the onboarding
fields. The Store page renders these read-only; the subdomain and store
name also surface in `GET /api/dashboard/me`, but the full profile (the
`location`, `currency` and `businessPhone` the Store page shows) lives
here.

### Request

Headers:

- `Authorization: Bearer <accessToken>`

No path, query, or body parameters.

### Success response

Status: `200`

```json
{
  "storeId": "019f…",
  "name": "string",
  "businessType": "RETAIL",
  "location": "string",
  "currency": "NGN",
  "businessPhone": "string"
}
```

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `401`  | `UNAUTHORIZED` | Missing/invalid bearer token |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated staff (not owner) |
| `404`  | `NOT_FOUND` | Store no longer exists |
| `429`  | `RATE_LIMITED` | — |

---

## GET /api/dashboard/settings/notifications

Returns the store's notification preference toggles. The response always
contains the complete set of known toggles — unset values default to
`true` (opt-out by default is unsafe for alerts that protect inventory).

### Request

Headers:

- `Authorization: Bearer <accessToken>`

No path, query, or body parameters.

### Success response

Status: `200`

```json
{
  "lowStockAlerts": true,
  "paymentAlerts": true,
  "expiringSoonAlerts": true,
  "receiptsEnabled": true
}
```

- `receiptsEnabled` — whether **customer receipt emails** are sent after a
  successful transaction (see "Customer receipts" below). Default `true`.
  Turn it off to stop emailing receipts to your customers; it does not
  affect the merchant payment alerts above.

---

## PUT /api/dashboard/settings/notifications

Partial update with merge semantics: only supplied toggles change,
omitted ones keep their current value. Unknown keys are rejected (`.strict()`).

### Request

Headers:

- `Authorization: Bearer <accessToken>`

Body (all keys optional, at least one required):

```json
{
  "lowStockAlerts": false
}
```

### Success response

Status: `200` — the full persisted toggle set after the merge, same
shape as `GET /settings/notifications`.

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `400`  | `VALIDATION_ERROR` | Unknown key, non-boolean value, or empty body |
| `401`  | `UNAUTHORIZED` | Missing/invalid bearer token |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated staff (not owner) |
| `429`  | `RATE_LIMITED` | — |

---

## Customer receipts

Not an endpoint — the email the customer receives after a successful
transaction, governed by `receiptsEnabled` (default `true`).

- **Who gets it:** the customer's email captured on the order
  (`Order.receiptEmail`, frozen at sale time) or, for invoices, the
  invoice customer's email. Orders/sales with no customer email (e.g. a
  POS walk-in cash sale) send nothing — it is best-effort and never
  blocks the money path.
- **Branding:** each receipt is rendered with the MERCHANT's own store
  details — store name, logo and accent color (from template settings,
  falling back to storefront settings), business address and phone,
  storefront link, and social links — plus a small "Powered by Brikoh"
  footer line.
- **Sender identity:** sent from the platform address
  `receipts@admin.brikoh.com` with the **store name as the display name**
  and **reply-to set to the owner's account email**, so customer replies
  reach the merchant.
- **When it fires:** after a successful transaction on any path — storefront
  card checkout, POS card sale (via the payment webhook), storefront
  bank-transfer confirmation, POS cash/transfer/credit sale, and invoice
  payment.
- **Idempotency:** send-once per order/payment (deduped), so webhook
  redeliveries never produce duplicate receipts.

---

## GET /api/dashboard/settings/storefront

Reads the storefront settings — what the public storefront renders
(template, hero copy, accent color, WhatsApp button, social links, the
"Powered by Brikoh" badge toggle). The response always contains the
complete known set: unset values fall back to the defaults below.

The public storefront reads the same fields without authentication via
`GET /api/public/storefront/:subdomain` (`public-storefront.md`) — this
endpoint is the dashboard's owner-only mirror.

### Request

Headers:

- `Authorization: Bearer <accessToken>`

No path, query, or body parameters.

### Success response

Status: `200`

```json
{
  "template": "CLASSIC",
  "tagline": null,
  "heroTitle": null,
  "heroSubtitle": null,
  "accentColor": "#18181b",
  "whatsappButtonEnabled": false,
  "whatsappNumber": null,
  "showPoweredByBadge": true,
  "ga4MeasurementId": null,
  "socialLinks": {
    "instagram": null,
    "facebook": null,
    "tiktok": null
  }
}
```

Field rules:

- `template` — `CLASSIC | MODERN | BOLD`; default `CLASSIC`.
- `tagline` — string 1-80 or null; default null.
- `heroTitle` — string 1-60 or null; default null.
- `heroSubtitle` — string 1-120 or null; default null.
- `accentColor` — hex string, **must be a member of the fixed swatch**
  (`#18181b`, `#16a34a`, `#2563eb`, `#ea580c`, `#db2777`, `#7c3aed`,
  `#0d9488`, `#dc2626`); default `#18181b`. The swatch is deliberately
  fixed — the storefront's palette is a curated brand choice, never a
  free-form color.
- `whatsappButtonEnabled` — boolean; default `false`.
- `whatsappNumber` — valid phone number (same rule as `businessPhone`)
  or null; default null.
- `showPoweredByBadge` — boolean; default `true`.
- `ga4MeasurementId` — Google Analytics 4 measurement ID (`G-` followed by
  6-12 uppercase letters/digits) or null; default null. When set, the
  public storefront injects the corresponding gtag snippet.
- `socialLinks` — object of http(s) URLs, each key optional and null-able;
  all default null. These power the social links on the storefront and
  receipts.

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `401`  | `UNAUTHORIZED` | Missing/invalid bearer token |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated staff (not owner) |
| `404`  | `NOT_FOUND` | Store no longer exists |
| `429`  | `RATE_LIMITED` | — |

---

## PUT /api/dashboard/settings/storefront

Partial update with merge semantics: only supplied keys change, omitted
ones keep their current value. An explicit `null` clears a nullable
field to its default. Unknown keys are rejected (`.strict()`).

### Request

Headers:

- `Authorization: Bearer <accessToken>`

Body (all keys optional, at least one required):

```json
{
  "template": "MODERN",
  "heroTitle": "Fresh goods, daily",
  "accentColor": "#16a34a",
  "whatsappButtonEnabled": true,
  "whatsappNumber": "+2348012345678",
  "ga4MeasurementId": "G-ABCDE12345"
}
```

### Success response

Status: `200` — the full persisted setting set after the merge, same
shape as `GET /settings/storefront`.

Every successful update writes a `store.storefront.settings.updated`
entry to the store activity log with the changed field list.

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `400`  | `VALIDATION_ERROR` | Unknown key, invalid value (e.g. an accent color outside the swatch, a malformed URL), or empty body |
| `401`  | `UNAUTHORIZED` | Missing/invalid bearer token |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated staff (not owner) |
| `404`  | `NOT_FOUND` | Store no longer exists |
| `429`  | `RATE_LIMITED` | — |

---

## POST /api/dashboard/settings/password

Changes the account's password and **revokes every active refresh
token**, logging all other sessions out. The caller must prove knowledge
of the current password.

### Request

Headers:

- `Authorization: Bearer <accessToken>`

Body:

```json
{
  "currentPassword": "string — required",
  "newPassword": "string — required, min 8",
  "confirmPassword": "string — required, must match newPassword"
}
```

### Success response

Status: `200`

```json
{
  "ok": true
}
```

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `400`  | `VALIDATION_ERROR` | Missing/invalid fields, passwords mismatch |
| `401`  | `UNAUTHORIZED` | Missing/invalid bearer token |
| `401`  | `INVALID_CREDENTIALS` | `currentPassword` is incorrect |
| `429`  | `RATE_LIMITED` | — |

---

## DELETE /api/dashboard/account

Permanently deletes the authenticated account and, when it owns a
store, the entire tenant: orders, line items, stock ledger, customers,
branches, products, activity log, subscription history, payment
credentials, and all staff. **This is irreversible.**

Teardown order inside one transaction: the store (and every
tenant-scoped row via cascade) is deleted first, then the ownership
record and the account itself. This ordering is required by the schema's
`Owner.accountId onDelete: Restrict` guard (an account with an ownership
record cannot be deleted while its store exists).

### Request

Headers:

- `Authorization: Bearer <accessToken>`

No path, query, or body parameters.

### Success response

Status: `200`

```json
{
  "ok": true
}
```

The response returns only after the deletion committed.

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `401`  | `UNAUTHORIZED` | Missing/invalid bearer token |
| `404`  | `NOT_FOUND` | Account no longer exists |
| `429`  | `RATE_LIMITED` | — |

Uniform error body shape (see `docs/api-contracts/README.md`).