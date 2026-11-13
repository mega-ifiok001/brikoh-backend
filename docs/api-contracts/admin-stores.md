# GET /api/admin/stores

Store fleet view: cap utilization, tier, and subscription status. Cursor-paginated,
newest stores first.

- **Auth:** admin, permission `admin:stores.view` (SUPER_ADMIN + SUPPORT_ADMIN).
- **Rate limit:** inherits the admin auth-group limiter.

## Query

| param    | type   | notes                                                                      |
| -------- | ------ | -------------------------------------------------------------------------- |
| `q`      | string | optional; matches store name / subdomain / customDomain (case-insensitive) |
| `limit`  | int    | default 50, max 100                                                        |
| `cursor` | uuid   | opaque page cursor                                                         |

## Response `200`

| field        | type           | notes               |
| ------------ | -------------- | ------------------- |
| `items`      | array          | see `items[]` below |
| `nextCursor` | string \| null |                     |

`items[]`:

| field                | type           | notes                                                                 |
| -------------------- | -------------- | --------------------------------------------------------------------- |
| `id`                 | string         |                                                                       |
| `name`               | string         |                                                                       |
| `subdomain`          | string         |                                                                       |
| `customDomain`       | string \| null |                                                                       |
| `currency`           | string         | store `Currency`                                                      |
| `tier`               | string \| null |                                                                       |
| `subscriptionStatus` | string \| null |                                                                       |
| `productCount`       | number         | live products (`deletedAt` is null)                                   |
| `productCap`         | number \| null | subscription product cap                                              |
| `status`             | string         | `subscription.status`, or `"NO_SUBSCRIPTION"` when the store has none |
| `createdAt`          | string         | ISO timestamp                                                         |

## Audit

Writes an `AdminAuditLog` row on **every** access — action `admin.stores.viewed`,
`detail: { q, limit, cursor }`.

## Errors

| Status | Condition                        |
| ------ | -------------------------------- |
| `401`  | no / invalid token               |
| `403`  | caller lacks `admin:stores.view` |
