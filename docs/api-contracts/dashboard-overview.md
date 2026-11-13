# GET /api/dashboard/overview

Route group: dashboard
Auth: bearer + store (`authenticate` + `resolveTenant`)
Rate-limited: no (read-only aggregation over the tenant's own data)

One aggregation endpoint feeding the dashboard home screen: KPI cards,
a 30-day revenue trend, top products, recent orders, low-stock and
expiring-product alerts, and quick counts. Money values are decimal
strings, never floats. All timestamps are UTC ISO-8601.

## Revenue visibility boundary

The Overview is open to **every authenticated tenant member** — no
additional permission flag gates the endpoint. Revenue-bearing fields
are masked for staff who do not hold the `viewProfit` permission:

| Widget | With `viewProfit` | Without |
| ------ | ----------------- | ------- |
| `kpis.revenue`, `kpis.avgOrderValue` | present | omitted (keys absent, not null) |
| `revenueTrend` | present | omitted |
| `kpis.orders`, `kpis.customers` | present | present |
| `topProducts[].revenue` | present | omitted per product |
| `recentOrders`, `lowStock`, `expiringSoon`, `quickStats` | present | present |

Owners hold `viewProfit` implicitly (they hold every permission); staff
hold it only when the store owner granted it in the staff form.

## Request

Headers:

- `Authorization: Bearer <accessToken>`

No query params, no path params, no body.

## Success response

Status: `200`

```json
{
  "kpis": {
    "revenue": "1250.50",
    "orders": 3,
    "customers": 12,
    "avgOrderValue": "416.83"
  },
  "revenueTrend": [
    {
      "start": "2026-08-01T00:00:00.000Z",
      "end": "2026-08-02T00:00:00.000Z",
      "totalSales": "1250.50",
      "orderCount": 3
    }
  ],
  "topProducts": [
    {
      "productId": "019f…",
      "name": "Bottled Water",
      "units": 7,
      "revenue": "800.00"
    }
  ],
  "recentOrders": [
    {
      "id": "019f…",
      "status": "PAID",
      "paymentMethod": "CASH",
      "source": "POS",
      "total": "1250.00",
      "customerName": "Ade Okafor",
      "lineItemCount": 2,
      "createdAt": "2026-08-12T10:00:00.000Z"
    }
  ],
  "lowStock": [
    {
      "productId": "019f…",
      "name": "Bottled Water",
      "branchId": "019f…",
      "branchName": "Main Branch",
      "quantity": 2
    }
  ],
  "expiringSoon": [
    {
      "productId": "019f…",
      "name": "Fresh Milk",
      "variantId": null,
      "expiryDate": "2026-08-16T00:00:00.000Z",
      "quantity": 6
    }
  ],
  "quickStats": {
    "productCount": 14,
    "branchCount": 1,
    "pendingOrderCount": 2,
    "creditOwing": "3500.00"
  }
}
```

Field notes:

- `kpis.revenue` — total of successful (`PAID`/`SHIPPED`) orders in the
  last 30 days (half-open `createdAt >= now − 30d`, `createdAt < now`),
  the same successful-sales rule analytics uses.
- `kpis.orders` — count of successful orders in the same 30-day window.
- `kpis.customers` — the store's total customer rows (all-time address
  book size, independent of the window).
- `kpis.avgOrderValue` — `revenue / orders` as a decimal string;
  `"0.00"` when there are no orders.
- `revenueTrend` — the same 30-day window bucketed **daily**, newest
  bucket first. `kpis.revenue` is the sum of these buckets.
- `topProducts` — the 5 best-selling products in the window, ranked by
  revenue descending then name ascending; `units` is the sum of line-item
  quantities. Products with `revenue` omitted still rank by revenue.
- `recentOrders` — the 10 most recent orders (any status), newest first.
- `lowStock` — every `BranchStock` row whose `quantity <= 0` or
  `quantity <= product.lowStockThreshold` (products with a threshold),
  across all branches, ordered by quantity ascending.
- `expiringSoon` — products with `expiryDate` within the next 7 days,
  ordered by `expiryDate` ascending. `variantId` is always null (expiry
  is tracked at product level); `quantity` is the product's on-hand
  stock. Products with variants report their cached product-level
  quantity (multi-variant stock lives per-variant and is not included
  here).
- `quickStats.creditOwing` — sum of `total − amountPaid` over CREDIT
  orders with `amountPaid < total`, restricted to **collectible statuses**
  (`PENDING | PAID | SHIPPED` — cancelled, refunded, and failed orders
  never count as owing). Credit repayments
  (`dashboard-customers.md`) consume this: the value derives from
  `amountPaid`, so every repayment drops it automatically.
- `quickStats.pendingOrderCount` — orders with status `PENDING`.

## Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated staff without any tenant (should not happen — resolveTenant rejects first) |

Uniform error body shape (see `docs/api-contracts/README.md`).