# Subscription & plan enforcement (dashboard)

Route group: dashboard
Auth: bearer + store, **owner-only** (`requireOwner`) for usage & domain endpoints
Rate-limited: no for usage (cheap reads, owner-only); domain mutation inherits the
generic rate-limit profile of store settings.

A plan describes what the store's active `Subscription` allows — its resource
caps and feature flags. Caps are nullable: `null` means **unlimited**. A store
with no subscription (or a `null` cap) has no limit on that resource. Feature
flags are derived from the tier, not stored per-row (see "Plan tiers").

The tenant ALWAYS comes from `req.tenant.storeId` — client-supplied store IDs are
never trusted.

## Plan shapes

### `SubscriptionPlan` (returned by usage + used for enforcement)

| Field                            | Type                                                  | Meaning                                                            |
| -------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `tier`                           | `STARTER \| PRO \| ENTERPRISE`                        | The subscription's tier.                                           |
| `status`                         | `TRIALING \| ACTIVE \| PAST_DUE \| CANCELLED \| null` | `null` when the store has no subscription.                         |
| `active`                         | `boolean`                                             | `true` when the subscription is usable (`ACTIVE` or `TRIALING`).   |
| `limits`                         | object                                                | Per-resource caps — each `number \| null` (`null` = unlimited).    |
| `limits.staffCap`                | `number \| null`                                      | Active `StaffMember` rows allowed (invite enforcement reads this). |
| `limits.locationCap`             | `number \| null`                                      | `Location` rows allowed (create-location enforcement reads this).  |
| `limits.productCap`              | `number \| null`                                      | Non-deleted `Product` rows allowed.                                |
| `limits.orderCap`                | `number \| null`                                      | Orders in the current billing period allowed.                      |
| `limits.templateCap`             | `number \| null`                                      | Visible storefront templates (see `dashboard-store-templates.md`). |
| `featureFlags`                   | object                                                | Booleans derived from the tier.                                    |
| `featureFlags.customDomain`      | `boolean`                                             | Whether the store may set a custom domain.                         |
| `featureFlags.advancedAnalytics` | `boolean`                                             | Advanced analytics UI is enabled.                                  |
| `featureFlags.marketingTools`    | `boolean`                                             | Marketing-suite features are enabled.                              |

### Plan tiers

| Tier         | staffCap | locationCap | productCap | orderCap | templateCap | customDomain | advancedAnalytics | marketingTools |
| ------------ | -------- | ----------- | ---------- | -------- | ----------- | ------------ | ----------------- | -------------- |
| `STARTER`    | `1`      | `1`         | `100`      | `1000`   | `3`         | `false`      | `false`           | `false`        |
| `PRO`        | `10`     | `3`         | `500`      | `5000`   | `5`         | `true`       | `true`            | `false`        |
| `ENTERPRISE` | `null`   | `null`      | `null`     | `null`   | `null`      | `true`       | `true`            | `true`         |

`null` caps in a tier (ENTERPRISE) are passed through as `null` (unlimited). A
`Subscription` row whose cap column is non-null **overrides** the tier default.
A store with no subscription reports every cap as `null` (unlimited).

**`templateCap` deviation:** unlike the resource caps, a store with no
subscription does NOT get unlimited templates — it sees the STARTER set
(3). This is deliberate: template selection must work at onboarding, and
billing is not wired yet, so every store is pre-subscription then. An
inactive subscription (PAST_DUE/CANCELLED) also degrades to the STARTER
set (templates are cosmetic; see `dashboard-store-templates.md`).

### Billing period (order cap window)

`orderCap` applies to orders created within the subscription's billing period:
`createdAt >= currentPeriodStart AND createdAt < currentPeriodEnd`. `currentEnd`
is always present on an active subscription. `currentPeriodStart` is present on
subscriptions created/updated by this phase; for legacy rows without it the
window falls back to the last 30 days.

---

## GET /api/dashboard/subscriptions/usage

Returns the store's current plan plus live usage against each cap, so the UI can
render upgrade prompts and progress indicators in one request.

### Request

Headers:

- `Authorization: Bearer <accessToken>`

No path, query, or body parameters.

### Success response

Status: `200`

```json
{
  "plan": {
    "tier": "PRO",
    "status": "ACTIVE",
    "active": true,
    "limits": {
      "staffCap": 10,
      "locationCap": 3,
      "productCap": 500,
      "orderCap": 5000,
      "templateCap": 5
    },
    "featureFlags": {
      "customDomain": true,
      "advancedAnalytics": true,
      "marketingTools": false
    }
  },
  "usage": {
    "staff": 3,
    "locations": 1,
    "products": 8,
    "orders": 47
  },
  "period": {
    "start": "2026-08-02T00:00:00.000Z",
    "end": "2026-09-01T00:00:00.000Z"
  },
  "customDomain": "shop.example.com"
}
```

- `usage.orders` counts orders whose `createdAt` falls in the billing period.
- `usage.locations` counts the store's `Location` rows (the store's own
  `Store.location` string is the primary storefront and is not a plan resource).

### Error responses

| Status | Condition                   |
| ------ | --------------------------- |
| `401`  | Unauthenticated             |
| `403`  | Staff role (owner required) |

---

## GET /api/dashboard/subscriptions/plan

Owner-only read of the resolved plan for the tenant. Used by the UI to gate
features client-side in sync with the server. Shape is the `plan` object from
the usage response (without `usage`/`period`). Same auth as usage.

---

## Custom domain configuration

## PUT /api/dashboard/subscriptions/custom-domain

Sets the store's `customDomain` (validated, unique). **Gated by
`featureFlags.customDomain`** — a store whose tier does not include the flag is
rejected with `403 PLAN_FEATURE_LOCKED` _before_ any domain lookup, including
when a caller attempts to bypass the UI and send the request directly.

Sets the store's `customDomain`. **Gated by `featureFlags.customDomain`** — a
store whose tier does not include the flag is rejected with
`403 PLAN_FEATURE_LOCKED` _before_ any domain logic runs, including when a
caller attempts to bypass the UI and POST the request directly. The unique
constraint on `Store.customDomain` means another store already claiming the
domain yields `409 CUSTOM_DOMAIN_TAKEN`.

## Enforcement summary (retrofitted into existing services)

All caps count ACTIVE rows/resources only. `null` cap → unlimited → never enforced.

**Lifecycle note:** cap enforcement is _only_ active when the store has a
subscription row. A store with no subscription (or `subscriptionId == null`)
has unlimited capacity on every resource — this keeps the existing checkout /
product-create flows green for stores not yet on a plan. The `SUBSCRIPTION_INACTIVE`
gate (no subscription, or `PAST_DUE`/`CANCELLED`) gates only **plan-gated features**
(custom-domain configuration) and is reported (not enforced) in the usage view.

| Resource            | Enforced where                                              | Counts                     | At/over/under                                  | Error at/above cap                                                                              |
| ------------------- | ----------------------------------------------------------- | -------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `staffCap`          | `POST /api/dashboard/staff/invites` (`createInvite`)        | active `StaffMember` rows  | `count == cap` rejected, `count < cap` allowed | `409 STAFF_LIMIT_REACHED` (already implemented, reads `Store.subscription`)                     |
| `locationCap`       | `POST /api/dashboard/locations` (`createLocation`)          | `Location` rows            | `count == cap` rejected, `count < cap` allowed | `409 LOCATION_LIMIT_REACHED`                                                                    |
| `productCap`        | `POST /api/dashboard/products` (`createProduct`)            | non-deleted `Product` rows | `count == cap` rejected, `count < cap` allowed | `409 PRODUCT_LIMIT_REACHED`                                                                     |
| `orderCap`          | `POST /api/public/checkout/:subdomain` (`initiateCheckout`) | orders in billing period   | `count == cap` rejected, `count < cap` allowed | `409 ORDER_LIMIT_REACHED`                                                                       |
| `customDomain` flag | `PUT /api/dashboard/subscriptions/custom-domain`            | — (feature gate)           | —                                              | `403 PLAN_FEATURE_LOCKED` (not a cap, a feature gate; `SUBSCRIPTION_INACTIVE` if no active sub) |

Cap semantics (the inequality direction the tests assert):

- **under** (`count < cap`): allowed (happy path).
- **exactly at** (`count == cap`): rejected (edge — the next create is blocked).
- **over** (client sends a count already > cap via a forged/concurrently-created
  resource): rejected on the next create; the cap is a _gate on new writes_, not
  a retroactive cleanup. A store already over cap (e.g. migrated) is not
  hard-blocked at read time, but no NEW resource that crosses the cap is
  persisted.

Each error body is the uniform shape below. Upgrade-promoting messages name the
plan needed to restore the capability.

## Error body shape (uniform across the API)

```json
{
  "error": {
    "code": "string",
    "message": "string"
  }
}
```

New codes introduced by this phase:

| Code                     | Status | Meaning                                                                       |
| ------------------------ | ------ | ----------------------------------------------------------------------------- |
| `PRODUCT_LIMIT_REACHED`  | `409`  | A new product would exceed the plan's `productCap`.                           |
| `ORDER_LIMIT_REACHED`    | `409`  | A new order would exceed the plan's `orderCap` for the billing period.        |
| `LOCATION_LIMIT_REACHED` | `409`  | A new location would exceed the plan's `locationCap`.                         |
| `PLAN_FEATURE_LOCKED`    | `403`  | The plan's feature flags do not include the requested capability.             |
| `SUBSCRIPTION_INACTIVE`  | `403`  | The store has no ACTIVE/TRIALING subscription; plan-gated writes are blocked. |

---

## Locations (create + list)

Route group: dashboard. Auth: bearer + store, `locations.manage` permission
(owners pass implicitly).

## POST /api/dashboard/locations

Creates a location for the tenant **after** enforcing the plan's `locationCap`
(no new location is persisted at/over the cap). A store with no subscription (or
a `null` locationCap) is unlimited.

### Request

Headers:

- `Authorization: Bearer <accessToken>`

Body:

```json
{
  "name": "Lagos Flagship",
  "address": "12 Adeola Odeku St, Victoria Island, Lagos"
}
```

### Success response

Status: `201`

```json
{
  "id": "019f…",
  "name": "Lagos Flagship",
  "address": "12 Adeola Odeku St, Victoria Island, Lagos",
  "createdAt": "2026-08-05T10:00:00.000Z"
}
```

### Error responses

| Status | Code                       | Condition                                                                                    |
| ------ | -------------------------- | -------------------------------------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`         | `name` missing/blank/too long.                                                               |
| `401`  | `UNAUTHORIZED`             | Unauthenticated.                                                                             |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `locations.manage`.                                                       |
| `409`  | `LOCATION_LIMIT_REACHED`   | `Location` rows already at/over `locationCap`; upgrade-promoting message, nothing persisted. |

## GET /api/dashboard/locations

Lists the tenant's `Location` rows, oldest first. Same auth as POST.

### Success response

Status: `200` — array of the POST response shape (without `createdAt` detail
omitted). Tenant-scoped: never returns another store's locations.

---

# Subscription billing (self-serve, recurring)

Route group: dashboard. Auth: bearer + store, **owner-only** (`requireOwner`).
Rate-limited: writes (`checkout`/`upgrade`/`downgrade`/`cancel`) at the
payments baseline (60/min); reads are not rate-limited.

Merchants bill themselves for Brikoh subscriptions through Paystack. This is
the PLATFORM collecting from merchants — it uses the platform's own Paystack
account (`PLATFORM_PAYSTACK_SECRET_KEY` / `PLATFORM_PAYSTACK_PUBLIC_KEY`), NOT
the merchant's storefront `PaymentCredential`. Checkout requires the tier to
have an admin-configured `monthlyPrice` + `paystackPlanCode` on
`SubscriptionPlanSetting`; otherwise it is `409 PRICING_NOT_CONFIGURED`.

Billing is **recurring**: the first checkout subscribes the merchant (Paystack
auto-charges monthly). Renewals arrive via `POST /api/webhooks/paystack-subscriptions`.

## GET /api/dashboard/subscriptions/plan

Returns the resolved plan (top-level, backward compatible) plus a
`pendingDowngrade` extension:

```json
{
  "tier": "PRO",
  "status": "ACTIVE",
  "active": true,
  "limits": { "...": "..." },
  "featureFlags": { "...": "..." },
  "pendingDowngrade": {
    "tier": "STARTER",
    "effectiveAt": "2026-10-01T00:00:00.000Z",
    "warnings": [ { "type": "OVER_CAP", "resource": "products", "current": 200, "targetCap": 100, "excess": 100, "message": "..." } ]
  }
}
```

`pendingDowngrade` is `null` when no downgrade is scheduled. **`PAST_DUE`
subscriptions stay `active: true` for the grace window** (`pastDueAt + 3d`)
before enforcement flips them.

## POST /api/dashboard/subscriptions/checkout

Body: `{ "tier": "STARTER" | "PRO" | "ENTERPRISE" }`

Opens a Paystack checkout that bills the first month and subscribes the
merchant. Records a `PENDING` `SubscriptionPayment` (kind `SUBSCRIPTION`).

Status `201`:
```json
{ "reference": "sub_ABC...", "authorizationUrl": "https://checkout.paystack.com/...", "amount": "4900.00", "tier": "PRO" }
```

Errors: `409 PRICING_NOT_CONFIGURED` (tier unset), `409 ALREADY_SUBSCRIBED`.

## POST /api/dashboard/subscriptions/upgrade

Body: `{ "tier": "..." }` (a higher-priced tier).

Charges the **prorated difference** for the remaining days of the current
cycle as a one-off transaction (no plan). The tier + caps + feature flags
switch **immediately at charge-success** (webhook), which also swaps the
Paystack plan for the next cycle. Records a `PENDING` `SubscriptionPayment`
(kind `UPGRADE`).

Status `201`:
```json
{ "reference": "upg_ABC...", "authorizationUrl": "https://...", "proratedAmount": "2500.00", "tier": "ENTERPRISE", "effectiveImmediately": true }
```

Errors: `409 UPGRADE_NOT_HIGHER`, `409 PRICING_NOT_CONFIGURED`,
`409 PRORATION_ZERO` (no time left — wait for renewal).

## POST /api/dashboard/subscriptions/downgrade

Body: `{ "tier": "..." }` (a lower-priced tier).

**Deferred**: the store KEEPS its current tier/features until
`currentPeriodEnd`; the subscription sweep applies the change then. Sets
`pendingDowngradeTier`. Returns live **warnings** (never blocks):

Status `200`:
```json
{
  "currentTier": "PRO",
  "targetTier": "STARTER",
  "effectiveAt": "2026-10-01T00:00:00.000Z",
  "warnings": [
    { "type": "OVER_CAP", "resource": "products", "current": 200, "targetCap": 100, "excess": 100, "message": "..." },
    { "type": "FEATURE_LOST", "feature": "customDomain", "message": "..." },
    { "type": "TEMPLATE_LOST", "message": "..." }
  ]
}
```

Warnings are **derived from live usage**, never stored — they stay accurate
for the whole deferral window.

Errors: `409 DOWNGRADE_NOT_LOWER`, `409 PRICING_NOT_CONFIGURED`.

## GET /api/dashboard/subscriptions/downgrade/preview?tier=STARTER

Read-only counterpart of the downgrade warnings — returns the same
`{ currentTier, targetTier, effectiveAt, warnings }` WITHOUT scheduling
anything.

## POST /api/dashboard/subscriptions/cancel

Disables the Paystack recurring subscription and marks the store's
`Subscription` `CANCELLED`. Status `200` `{ "ok": true }`.
Errors: `409 NO_SUBSCRIPTION`, `409 NO_PAYSTACK_SUBSCRIPTION`.

## GET /api/dashboard/subscriptions/payments

Append-only billing history, newest first:
```json
{ "items": [ { "id": "...", "tier": "PRO", "kind": "SUBSCRIPTION|UPGRADE|RENEWAL", "status": "PENDING|PAID|FAILED", "reference": "sub_...", "amount": "4900.00", "paidAt": "...", "createdAt": "...", "orphanReason": null } ] }
```

## GET /api/dashboard/subscriptions/payments/:id

One payment (adds `providerRef`). `404 PAYMENT_NOT_FOUND` for a foreign/unknown id.

## Webhook

`POST /api/webhooks/paystack-subscriptions` — platform-key signed. See
`public-webhook-paystack.md`. Handles initial subscribe, prorated upgrade
(with the deterministic plan swap and the same-cycle double-charge guard),
renewals, failures (grace), and subscription lifecycle events.

## Billing history model

One active `Subscription` row per store is mutated in place across the
lifecycle; every money movement is appended to `SubscriptionPayment`
(`SUBSCRIPTION` / `UPGRADE` / `RENEWAL`). An upgrade-detected double charge is
recorded with `orphanReason` and has no local effect.

