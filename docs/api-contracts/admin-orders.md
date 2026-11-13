# GET /api/admin/orders

Cross-tenant order log. Cursor-paginated, newest orders first.

- **Auth:** admin, permission `admin:orders.view` (SUPER_ADMIN + SUPPORT_ADMIN).
- **Rate limit:** inherits the admin auth-group limiter.

## Query

| param    | type   | notes                                                                                                                     |
| -------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `status` | enum   | optional `OrderStatus` filter (`PENDING` / `AWAITING_PAYMENT` / `PAID` / `SHIPPED` / `CANCELLED` / `REFUNDED` / `FAILED`) |
| `q`      | string | optional; matches `orderNumber` (case-insensitive)                                                                        |
| `limit`  | int    | default 50, max 100                                                                                                       |
| `cursor` | uuid   | opaque page cursor                                                                                                        |

## Response `200`

| field        | type           | notes               |
| ------------ | -------------- | ------------------- |
| `items`      | array          | see `items[]` below |
| `nextCursor` | string \| null |                     |

`items[]`:

| field             | type           | notes                        |
| ----------------- | -------------- | ---------------------------- |
| `id`              | string         |                              |
| `orderNumber`     | string         |                              |
| `storeId`         | string         |                              |
| `storeName`       | string         |                              |
| `customerName`    | string         |                              |
| `total`           | number         | order total (store currency) |
| `currency`        | string         | store `Currency`             |
| `status`          | string         | `OrderStatus`                |
| `paymentMethod`   | string \| null |                              |
| `paymentProvider` | string \| null |                              |
| `source`          | string         | `OrderSource`                |
| `createdAt`       | string         | ISO timestamp                |

## Audit

Writes an `AdminAuditLog` row on **every** access — action `admin.orders.viewed`,
`detail: { status, q, limit, cursor }`.

## Errors

| Status | Condition                        |
| ------ | -------------------------------- |
| `400`  | invalid `status` enum value      |
| `401`  | no / invalid token               |
| `403`  | caller lacks `admin:orders.view` |
