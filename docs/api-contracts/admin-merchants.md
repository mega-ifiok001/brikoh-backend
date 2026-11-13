# GET /api/admin/merchants

One row per Store, with the Owner, plus a trailing-30-day GMV. Cursor-paginated,
newest stores first.

- **Auth:** admin, permission `admin:merchants.view` (SUPER_ADMIN + SUPPORT_ADMIN).
- **Rate limit:** inherits the admin auth-group limiter.

## Query

| param    | type   | notes                                                                      |
| -------- | ------ | -------------------------------------------------------------------------- |
| `q`      | string | optional; matches `Store.name` OR owner `Account.email` (case-insensitive) |
| `limit`  | int    | default 50, max 100                                                        |
| `cursor` | uuid   | opaque page cursor (last item's `id` from a prior page)                    |

## Response `200`

| field        | type           | notes                                |
| ------------ | -------------- | ------------------------------------ |
| `items`      | array          | see `items[]` below                  |
| `nextCursor` | string \| null | `null` when the page is the last one |

`items[]`:

| field                | type           | notes                                                                 |
| -------------------- | -------------- | --------------------------------------------------------------------- |
| `id`                 | string         | store id                                                              |
| `storeName`          | string         |                                                                       |
| `ownerName`          | string         | `Account.firstName` + `lastName`, or `"—"` if missing                 |
| `ownerEmail`         | string         | owner `Account.email`                                                 |
| `tier`               | string \| null | subscription tier (lowercase), or `null`                              |
| `subscriptionStatus` | string \| null |                                                                       |
| `gmvLast30d`         | number         | sum of PAID order totals in the last 30 days, in the store's currency |
| `gmvCurrency`        | string         | store `Currency`                                                      |
| `orderCount`         | number         | total orders for the store (all statuses)                             |
| `createdAt`          | string         | ISO timestamp                                                         |

## Audit

Writes an `AdminAuditLog` row on **every** access — action `admin.merchants.viewed`,
`detail: { q, limit, cursor }` (the filters used, never the result set).

## Errors

| Status | Condition                           |
| ------ | ----------------------------------- |
| `401`  | no / invalid token                  |
| `403`  | caller lacks `admin:merchants.view` |
