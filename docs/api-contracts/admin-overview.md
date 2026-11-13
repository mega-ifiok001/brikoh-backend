# GET /api/admin/overview

Platform-health rollup, computed for real across all tenants.

- **Auth:** admin, permission `admin:overview.view` (SUPER_ADMIN only).
- **Rate limit:** inherits the admin auth-group limiter.

## Response `200`

| field                   | type    | notes                                                                                                                                                  |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `totalStores`           | number  | `Store` row count                                                                                                                                      |
| `subscriptionsByStatus` | object  | counts keyed by **every** `SubscriptionStatus` (`TRIALING`/`ACTIVE`/`PAST_DUE`/`CANCELLED`), zero-filled                                               |
| `orderCountsByStatus`   | object  | counts keyed by **every** `OrderStatus`, zero-filled                                                                                                   |
| `revenueByCurrency`     | array   | `[{ currency, total }]` — sum of `Order.total` for **PAID** orders, grouped by the store's `Currency`. Never a single blended number; no FX conversion |
| `mrr`                   | number  | sum of `SubscriptionPlanSetting.monthlyPrice` for every **ACTIVE** subscription (its store's current tier). NGN only — do not convert                  |
| `mrrCurrency`           | `"NGN"` | billing currency of MRR                                                                                                                                |

## Audit

Writes an `AdminAuditLog` row on **every** access — action `admin.overview.viewed`,
`detail: {}` (cross-tenant read view, logged by contract).

## Errors

| Status | Condition                          |
| ------ | ---------------------------------- |
| `401`  | no / invalid token                 |
| `403`  | caller lacks `admin:overview.view` |
