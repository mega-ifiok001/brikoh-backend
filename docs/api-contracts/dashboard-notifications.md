# Dashboard notifications — merchant alerts

Route group: dashboard
Auth: bearer + store, **owner-only** (`requireOwner`)

The merchant-alert surface: the recent-alert inbox and the test-alert
sender. The toggles that govern WHAT gets emailed live in
`dashboard-settings.md` (`GET/PUT /api/dashboard/settings/notifications`);
this module is the engine that consumes them.

## Alert kinds

| Kind | Toggle | Trigger | Dedup |
| ---- | ------ | ------- | ----- |
| `LOW_STOCK` | `lowStockAlerts` | Scheduled sweep (interval `ALERT_SWEEP_INTERVAL`, default 6h): a branch's cached stock at or below zero, or at/below the product's `lowStockThreshold` | Per (store, branch-stock row): re-alert only when the quantity has **worsened** since the last send (`sentQuantity` on the previous dispatch) |
| `EXPIRING_SOON` | `expiringSoonAlerts` | Same sweep: `expiryDate` within the 7-day grace window (same `EXPIRING_WINDOW_DAYS` as the overview home screen) | Once per product — a product expires once |
| `PAYMENT_RECEIVED` | `paymentAlerts` | Event-driven, the moment money arrives: storefront checkout (order `PENDING → PAID`, live webhook or admin replay), a credit repayment, or an invoice payment | Once per financial row (`ORDER` / `CREDIT_REPAYMENT` / `INVOICE_PAYMENT`) |
| `PAYMENT_CLAIMED` | `paymentAlerts` | Event-driven: a buyer clicks "I have paid" on a `bank_transfer` order (`public-orders.md`), moving it `PENDING → AWAITING_PAYMENT` | Once per order (the claim event); idempotent — a repeat click does not re-alert |

Semantics:

- **Recipient** — the store owner's account email (`Store → Owner → Account.email`). Staff never receive merchant alerts in this phase.
- **Delivery** — email, one consolidated email per store per kind per sweep run. Payment alerts are one email per payment event.
- **Best-effort** — alert sending is fire-and-forget: a send failure is logged and NEVER fails the API response or the payment/webhook that triggered it (the money is already recorded before any email attempt).
- **Toggle defaults** — unset toggles default to enabled (opt-out, never opt-in — the settings contract keeps this rule).
- **Opt-out** — a store with the toggle off is skipped entirely: no query, no email, no dispatch row.

## GET /api/dashboard/notifications

Recent alert dispatches, newest first, cursor-paginated (same shape
conventions as the activity log).

### Request

Headers:

- `Authorization: Bearer <accessToken>`

Query params:

- `limit: number — optional, default 20, max 100`
- `cursor: string — optional, opaque dispatch id, returns rows created before it`
- `kind: string — optional, filter to one alert kind`

### Success response

Status: `200`

```json
{
  "dispatches": [
    {
      "id": "019f…",
      "kind": "LOW_STOCK",
      "refType": "BRANCH_STOCK",
      "refId": "019f…",
      "sentQuantity": 2,
      "snapshot": {
        "productName": "Tomatoes",
        "branchName": "Main Branch",
        "quantity": 2,
        "threshold": 5
      },
      "sentAt": "2026-08-14T09:00:00.000Z"
    }
  ],
  "nextCursor": "019f…"
}
```

`snapshot` is the condition rendered in the email at send time (item
names, quantities, amounts), so history survives product renames and
branch deletions. `sentQuantity` is present only on `LOW_STOCK` rows.

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `401`  | `UNAUTHORIZED` | Missing/invalid bearer token |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated staff (not owner) |
| `429`  | `RATE_LIMITED` | — |

## POST /api/dashboard/notifications/test

Sends a test alert email to the owner's address — the "did I wire up the
right mailbox" check. It does not write a dispatch row (no business
condition was alerted) and is never gated by the toggles.

### Request

Headers:

- `Authorization: Bearer <accessToken>`

Body: none required (empty object accepted).

### Success response

Status: `200`

```json
{
  "sent": true,
  "to": "owner@example.com"
}
```

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `400`  | `VALIDATION_ERROR` | Body is not an object |
| `401`  | `UNAUTHORIZED` | Missing/invalid bearer token |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated staff (not owner) |
| `404`  | `NOT_FOUND` | Store has no owner record |
| `429`  | `RATE_LIMITED` | — |

---

## Operational notes (not endpoints)

- **Scheduler** — the sweep runs as an in-process timer on the API
  server (`server.ts`), interval `ALERT_SWEEP_INTERVAL` (duration string
  like `30m`, `6h`; default `6h`). It is a best-effort job: it dies with
  the process and does not survive restarts. An external cron hitting an
  internal trigger endpoint is a later-phase hardening — no queue or
  worker infrastructure exists yet.
- **Tests** — under `NODE_ENV=test` the scheduler is a no-op and the
  sweep is invoked directly; the sender is the console stub (never a
  real network send).
