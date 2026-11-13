# Admin dashboard endpoints

Route group: admin
Auth: admin bearer (see below) — a SEPARATE token type from the store/
staff bearer. Admin tokens are issued by the admin login endpoint, carry
`sub = adminUserId`, and are minted with their own secret. They never
mix with `Account`/store JWTs.
Rate-limited: login and pricing writes yes; everything else no.

The admin dashboard is platform staff tooling. Tenant resolution
(`resolveTenant`) does NOT apply here — admin routes are never scoped to a
single store by the request context. Cross-store actions are recorded in
the append-only audit log at "which record" granularity, never at page-view
granularity.

Base path: `/api/admin`

## Admin access model

Two roles, seeded on deploy:

- `SUPER_ADMIN` — full access; every permission key below.
- `SUPPORT_ADMIN` — non-financial read only: `stores:view`, `admin:merchants.view`,
  `admin:stores.view`, `admin:orders.view`. `admin:overview.view` (the
  financial rollup) is reserved for `SUPER_ADMIN`.

Permissions are data, not code: a brand-new `Permission` row plus a
`RolePermission` assignment grants a key to a role with ZERO schema changes
(the additive-permission model — covered by its own test). The complete seed
set:

| Key                    | Grants                                                                   |
| ---------------------- | ------------------------------------------------------------------------ |
| `stores:view`          | store search, store detail, health metrics, pricing read                 |
| `billing:edit`         | update subscription pricing                                              |
| `operations:run`       | webhook reprocess, integrity diagnostics                                 |
| `audit:view`           | read the audit log (endpoint additionally requires SUPER_ADMIN)          |
| `admin:overview.view`  | platform financial rollup (`GET /api/admin/overview`) — SUPER_ADMIN only |
| `admin:merchants.view` | merchant (store + owner) list (`GET /api/admin/merchants`)               |
| `admin:stores.view`    | store fleet view (`GET /api/admin/stores`)                               |
| `admin:orders.view`    | cross-tenant order log (`GET /api/admin/orders`)                         |
| `admin:announcements.view` | list announcements and read view counts (SUPER_ADMIN only)           |
| `admin:announcements.manage` | create, edit, publish, and deactivate announcements (SUPER_ADMIN only) |
| `admin:telemetry.view` | funnel and median-time telemetry (SUPER_ADMIN only) |
| `admin:payments.awaiting-confirmation.view` | read pending bank-transfer claims (SUPPORT_ADMIN + SUPER_ADMIN) |
| `admin:staff.view` | list platform staff session metadata (SUPER_ADMIN only) |

## Health metric definitions (shared, centralized)

These are platform-level KPIs. Their definitions live ONCE in the shared
analytics module (`src/modules/analytics/lifecycle.ts`); every endpoint and
the merchant dashboards call the same helpers. If a definition changes, it
changes in exactly one place.

### Activation (operational proxy)

There is no explicit storefront "live" flag yet, so _activated_ is proxied
as: **a store with at least one published product (a non-soft-deleted
`Product` row) whose `createdAt` falls within 24 hours of the store's
`createdAt`.** This is an operational proxy: it is replaced by a true
activation event later WITHOUT changing this API contract. The 24h window
lives in `ACTIVATION_WINDOW_MS`.

### Churn (official definition)

- **Numerator:** stores whose subscription transitioned from `ACTIVE` to a
  non-active state (`CANCELLED` — `EXPIRED` joins the list when
  subscriptions auto-expire) during the reporting period.
- **Denominator:** stores whose subscription was `ACTIVE` at the **start**
  of the reporting period. Subscriptions **created during the period are
  excluded** from the denominator.

`CHURNED_STATUSES` holds the non-active set as a shared constant.

### MRR

Monthly Recurring Revenue = sum of the current monthly price (from
`SubscriptionPlanSetting`, the admin-mutable pricing table) across all
subscriptions with `status = ACTIVE`. Plans priced `null` (STARTER) are
excluded. Prices are NOT compiled into code — the admin dashboard reads and
writes them through the pricing endpoints below.

## POST /api/admin/auth/login

Route group: admin (public auth; rate-limited)
Auth: none

Login always requires the current TOTP 6-digit code: there is no admin
session without a verified 2FA code. The `twoFactorSecret` is seeded per
admin (rotatable via the rotate endpoint below).

Body:

```json
{
  "email": "string",
  "password": "string",
  "totpToken": "string (6 digits)"
}
```

Success — Status: `200`

```json
{
  "accessToken": "string",
  "refreshToken": "string (rt_… opaque; see refresh flow below)",
  "admin": { "id": "uuid", "email": "string", "roleName": "string" }
}
```

The short-lived `accessToken` (default `ADMIN_JWT_ACCESS_EXPIRES_IN = 15m`)
authorizes every admin request via `Authorization: Bearer`. The `refreshToken`
(default `ADMIN_JWT_REFRESH_EXPIRES_IN = 7d`) keeps the admin signed in across
access-token expiries without re-entering the TOTP code — see
`POST /api/admin/auth/refresh` and `POST /api/admin/auth/logout` below.

Rotating or resetting 2FA (below) **revokes all of that admin's refresh
tokens**, forcing a fresh login with the new secret — a leaked refresh token
cannot outlive a credential change.

Error responses:

| Status | Condition                                               |
| ------ | ------------------------------------------------------- |
| `400`  | Malformed body / invalid TOTP format                    |
| `401`  | Unknown email or wrong password (`INVALID_CREDENTIALS`) |
| `401`  | Invalid/expired TOTP (`2FA_INVALID`)                    |
| `403`  | Admin account deactivated (`ACCOUNT_DISABLED`)          |
| `429`  | Rate limited                                            |

## POST /api/admin/auth/refresh

Rotates the presented admin `refreshToken` into a fresh access + refresh pair.
The presented token is single-use: on success it is revoked and a new family is
issued, so the client must persist the new `refreshToken` each time.

Route group: admin (public auth; rate-limited)
Auth: none (requires the opaque `refreshToken`)

Body:

```json
{ "refreshToken": "string (rt_…)" }
```

Success — Status: `200`

```json
{
  "accessToken": "string",
  "refreshToken": "string (new rt_… — store this)",
  "admin": { "id": "uuid", "email": "string", "roleName": "string" }
}
```

Error responses:

| Status | Condition                                                       |
| ------ | --------------------------------------------------------------- |
| `400`  | Malformed body / missing `refreshToken`                         |
| `401`  | Malformed/unknown token (`INVALID_REFRESH_TOKEN`)               |
| `401`  | Token expired (`SESSION_EXPIRED`) — sign in again               |
| `401`  | Replayed (already-revoked) token (`TOKEN_REUSE_DETECTED`) — all |
|        | sessions for that admin are revoked; re-authenticate            |
| `429`  | Rate limited                                                    |

## POST /api/admin/auth/logout

Revokes the presented admin `refreshToken` (and its session family). Idempotent:
a malformed, unknown, or already-revoked token is treated as already logged out.

Route group: admin (public auth; rate-limited)
Auth: none (requires the opaque `refreshToken`)

Body:

```json
{ "refreshToken": "string (rt_…)" }
```

Success — Status: `204` (no body)

Error responses:

| Status | Condition                               |
| ------ | --------------------------------------- |
| `400`  | Malformed body / missing `refreshToken` |
| `429`  | Rate limited                            |

## POST /api/admin/auth/2fa/rotate

Rotates the authenticating admin's own 2FA secret. The current secret is
replaced immediately; the new secret is returned exactly once. All of this
admin's refresh tokens are revoked, so every active session must re-authenticate
with the new secret.

Auth: admin bearer. Rate-limited.

Request body: `{}`

Success — Status: `200`

```json
{
  "secret": "base32 string",
  "otpauthUrl": "otpauth://totp/...?secret=...",
  "provisioningNotice": "store this secret; it is shown once"
}
```

## POST /api/admin/auth/2fa/reset

Break-glass: a `SUPER_ADMIN` force-rotates ANOTHER admin's 2FA secret to
recover a lost authenticator. This is strictly **non-destructive** — it
updates ONLY the target admin's `twoFactorSecret`, INSERTS exactly one
append-only audit row (`admin.2fa.reset`), and touches nothing else
(including the audit trail itself, which the DB trigger forbids mutating).
Existing short-lived access tokens keep working until natural expiry, but ALL
of the target's refresh tokens are revoked — so each session must re-authenticate
with the new secret once its current access token expires.

Auth: admin bearer **and** `SUPER_ADMIN` (enforced in the service — `403
FORBIDDEN` for any non-SUPER_ADMIN caller). Rate-limited.

Body:

```json
{ "adminUserId": "uuid" }
```

Success — Status: `200`

```json
{
  "email": "string",
  "secret": "base32 string",
  "otpauthUrl": "otpauth://totp/...?secret=..."
}
```

| Status | Condition                                 |
| ------ | ----------------------------------------- |
| `400`  | Malformed body / non-uuid `adminUserId`   |
| `403`  | Caller is not `SUPER_ADMIN` (`FORBIDDEN`) |
| `404`  | No admin found with that id (`NOT_FOUND`) |

## GET /api/admin/me

Auth: admin. Returns the authenticating admin.

Success — Status: `200`

```json
{
  "id": "uuid",
  "email": "string",
  "roleName": "SUPER_ADMIN",
  "permissions": ["stores:view", "billing:edit", "operations:run", "audit:view"]
}
```

## GET /api/admin/audit-log

Permission `audit:view AND the calling admin must be `SUPER_ADMIN` (enforced in
the service — granting the permission is not sufficient).

Query params (all optional; the range defaults to the last 30 days):

- `adminId: uuid — filter by performer`
- `storeId: uuid`
- `action: string` — exact action key (e.g. `billing.pricing.updated`)
- `start` / `end` — UTC UTC-ISO range (half-open, same semantics as analytics)
- `cursor: uuid` — pagination cursor (opaque, ISO timestamp tie-break not needed — createdAt DESC by default with id tie-break)
- `limit?` 1..100 (default 50)

Success — Status: `200`

```json
{
  "items": [
    {
      "id": "uuid",
      "adminUserId": "uuid",
      "adminEmail": "string",
      "action": "string",
      "storeId": null,
      "detail": { "key": "value" },
      "createdAt": "2026-08-05T12:00:00.000Z"
    }
  ],
  "nextCursor": "string | null"
}
```

`nextCursor` is null when there are no more pages.

## GET /api/admin/stores/search

Permission `stores:view`. Search merchants by name or owner email.

Query:

- `q?: string` — substring match on `Store.name` or the owner `Account.email`
- `tier?: starter|pro|enterprise` — filter by active subscription tier (null when no subscription)
- `subscriptionStatus?: active|inactive` — `active` = store has an ACTIVE subscription
- `cursor: string` / `limit?` 1..50 (default 25)

Success — Status: `200`

```json
{
  "items": [
    {
      "id": "uuid",
      "name": "string",
      "subdomain": "string | null",
      "businessType": "string",
      "ownerEmail": "string",
      "tier": "string",
      "subscriptionStatus": "string | null",
      "createdAt": "2026-08-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "string | null"
}
```

## GET /api/admin/stores/:storeId

Permission `stores:view`. Full support view of one store: plan, recent
orders, staff, connected payment provider + webhook health.

Success — Status: `200`

```json
{
  "id": "uuid",
  "name": "string",
  "subdomain": "string | null",
  "ownerEmail": "string",
  "businessType": "string",
  "createdAt": "string",
  "plan": {
    "tier": "pro",
    "status": "active",
    "currentPeriodStart": "string",
    "currentPeriodEnd": "string",
    "usage": { "staff": 0, "products": 0, "orders": 0 },
    "activeSubscriptionId": "uuid"
  },
  "staff": [
    {
      "id": "uuid",
      "role": "admin",
      "permissions": ["orders.manage"],
      "name": "string"
    }
  ],
  "recentOrders": [
    {
      "id": "uuid",
      "status": "paid",
      "total": "33.00",
      "createdAt": "string"
    }
  ],
  "paymentProvider": {
    "provider": "paystack | null",
    "webhookHealth": {
      "lastSuccessAt": "string | null",
      "lastFailureAt": "string | null",
      "lastEvents": [
        {
          "id": "uuid",
          "status": "processed",
          "event": "charge.success",
          "createdAt": "string"
        }
      ]
    }
  }
}
```

## GET /api/admin/health/signups

Permission `stores:view`. Store-creation counts over time.

Query: `start`, `end`, `granularity=daily|weekly | default daily)` — same
UTC range + bucket semantics as analytics.

Success — Status: `200`

```json
{
  "range": { "start": "string", "end": "string" },
  "granularity": "daily",
  "buckets": [{ "start": "string", "end": "string", "count": 0 }]
}
```

## GET /api/admin/health/activation

Permission `stores:view`. Activation rate per the shared proxy definition.

Query: `start`, `end`.

Success — Status: `200`

```json
{
  "range": { "start": "string", "end": "string" },
  "createdStores": 10,
  "activatedStores": 6,
  "activationRate": 60
}
```

`activationRate` is `Number` percent (one decimal) or `null` when
`createdStores` is 0.

## GET /api/admin/health/subscriptions

Permission `stores:view`. Status breakdown, tier counts, MRR (from the
admin-mutable product table).

Success — Status: `200`

```json
{
  "byStatus": [{ "status": "active", "count": 3 }],
  "byTier": [{ "tier": "starter", "count": 1, "monthlyPrice": null }],
  "metrics": { "activeSubscriptions": 3, "mrr": 0.0 },
  "computedAt": "2026-08-05T12:00:00.000Z"
}
```

## GET /api/admin/health/churn

Permission `stores:view`. Official churn definition (shared constant).

Query: `start`, `end`.

Success — Status: `200`

```json
{
  "range": { "start": "string", "end": "string" },
  "activeAtPeriodStart": 20,
  "churned": 2,
  "churnRate": 10
}
```

`churnRate` is `null` when `activeAtPeriodStart` is 0.

## GET /api/admin/billing/pricing

Permission `stores:view`. The current price for every plan.

Success — Status: `200`

```json
{
  "items": [
    { "plan": "starter", "monthlyPrice": null },
    { "plan": "pro", "monthlyPrice": 4900 },
    { "plan": "enterprise", "monthlyPrice": 19000 }
  ]
}
```

`monthlyPrice` is `null` = free/excluded (STARTER).

## PUT /api/admin/billing/pricing/:plan

Permission `billing:edit`. Updates a plan's monthly price. Every change is
written to the audit log (action `billing.pricing.updated`).

Body:

```json
{ "monthlyPrice": 5999 }
```

`monthlyPrice`: positive integer currency unit, or `null` to mark the plan
free/excluded.

Success — Status: `200`

```json
{ "plan": "pro", "monthlyPrice": 5999, "updatedAt": "string" }
```

Unsupported plan name → `400 INVALID_PLAN`.

## POST /api/admin/webhook-events/:eventId/reprocess

Permission `operations:run`. Re-runs the stored webhook payload through the
same order-fulfillment pipeline (webhooks service) with its guarded
transitions. Only events that have not been `PROCESSED` (status `PENDING` or
`FAILED`, `processedAt` null) can be replayed.

Success — Status: `200`

```json
{ "outcome": "PROCESSED" }
```

| Status | Condition                                                |
| ------ | -------------------------------------------------------- |
| `404`  | Unknown event id                                         |
| `409`  | Event already processed (replay runs no business effect) |
| `400`  | Stored payload no longer parses                          |

## GET /api/admin/integrity/ledger-anomalies

Permission `operations:run`. Two defect classes, listed in one response:

- `NEGATIVE_STOCK` — a `Product` with `quantity < 0`
- `LEDGER_MISMATCH` — the sum of that product's `StockLedgerEntry`
  `quantityChange` differs from `Product.quantity` (reconciliation)

Success — Status: `200`

```json
{
  "items": [
    {
      "storeId": "uuid",
      "storeName": "string",
      "productId": "uuid",
      "productName": "string",
      "quantity": -3,
      "ledgerTotal": 4,
      "issue": "NEGATIVE_STOCK"
    }
  ]
}
```

`ledgerTotal` is present for `LEDGER_MISMATCH`, `null` otherwise.

## GET /api/admin/integrity/orphaned-orders

Permission `operations:run`. Orders created more than
`ORPHANED_ORDER_WINDOW_HOURS` ago that are still `PENDING` — i.e. the
payment webhook never confirmed them within the window.

Query: `hours?=1..720` overrides the window (default 24).

Success — Status: `200`

```json
{
  "items": [
    {
      "orderId": "uuid",
      "storeId": "uuid",
      "storeName": "string",
      "status": "pending",
      "paymentReference": "string | null",
      "createdAt": "string"
    }
  ],
  "windowHours": 24
}
```

## GET /api/admin/moderation/flagged-content

Permission `operations:run`. The content-moderation review queue is not
built; this
returns the agreed placeholder shape so the frontend can render the empty
state and the API contract stays frozen.

Success — Status: `200`

```json
{
  "queue": [],
  "nextCursor": null,
  "reviewPolicy": "no moderation pipeline wired yet — pending shape"
}
```

## Shared error shapes

`401 UNAUTHORIZED` — missing/expired admin token. `403 FORBIDDEN` — the
admin has no role. `403 INSUFFICIENT_PERMISSIONS` — missing `key`.
`404 STORE_NOT_FOUND`. `404 ADMIN_EVENT_NOT_FOUND`. `429 RATE_LIMITED`.
Unified envelope:

```json
{
  "error": { "code": "string", "message": "string" }
}
```
