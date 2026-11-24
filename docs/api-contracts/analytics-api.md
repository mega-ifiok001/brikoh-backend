# Analytics endpoints

Route group: dashboard
Auth: bearer + store (authenticate + resolveTenant)
Permission: `analytics.manage` (owners pass implicitly)
Rate-limited: no

Base path: `/api/dashboard/analytics`

All five endpoints use one query parameter: `date=YYYY-MM-DD`. The date is a
real UTC calendar date. Each endpoint includes records from midnight on that
date up to (but not including) midnight the next day. `start`/`end` ranges
and weekly granularity are no longer accepted.

- All money values are returned as strings (`Decimal.toFixed(2)`), never
  floats.
- Every aggregation counts only **successful sales**: orders whose status
  is `PAID` or `SHIPPED`. PENDING / FAILED / CANCELLED / REFUNDED orders
  are never counted.

## GET /api/dashboard/analytics/summary

Tier: Basic — available on every tier, including stores with no
subscription.

Query params:

- `date: string (YYYY-MM-DD) — selected UTC calendar day — required`
- `top: integer 1..50 — number of best sellers to return (default 5)`

Example: `GET /api/dashboard/analytics/summary?date=2026-08-03`

Success response — Status: `200`

```json
{
  "date": "2026-08-03",
  "totalSales": "1250.50",
  "orderCount": 3,
  "bestSellers": [
    {
      "productId": "uuid",
      "name": "string",
      "units": 7,
      "revenue": "800.00"
    }
  ]
}
```

`bestSellers` are ranked by `revenue` descending, then `name` ascending
(deterministic tie-breaker). `units` is the sum of line-item quantities
across successful sales on the selected date; `revenue` is the sum of
`quantity × unitPriceAtPurchase` (prices captured at purchase time, never
re-read from the product). A date with no orders returns
`totalSales: "0.00"`, `orderCount: 0`, `bestSellers: []`.

## GET /api/dashboard/analytics/timeseries

Tier: Basic — available on every tier, including stores with no
subscription.

Query params:

- `date` — as above.
- `granularity: "daily"` (optional; daily is the only supported granularity)

Example: `GET /api/dashboard/analytics/timeseries?date=2026-08-03`

Success response — Status: `200`

```json
{
  "date": "2026-08-03",
  "granularity": "daily",
  "buckets": [
    {
      "date": "2026-08-03",
      "totalSales": "0.00",
      "orderCount": 0
    }
  ]
}
```

Bucket rules (deterministic across time zones — all math is UTC):

- The selected date has one daily bucket aligned to UTC midnight.
- The bucket is **zero-filled** when the date has no orders.
- Each bucket includes its calendar `date`; orders are assigned by the UTC
  day of `createdAt`.

## GET /api/dashboard/analytics/trends

Tier: Advanced — `PRO` and `ENTERPRISE` (feature flag
`advancedAnalytics`), with an active subscription.

Query params:

- `date`, `granularity` — as above.

Example: `GET /api/dashboard/analytics/trends?date=2026-08-03`

Success response — Status: `200`

```json
{
  "date": "2026-08-03",
  "granularity": "daily",
  "totals": { "totalSales": "1200.00", "orderCount": 3 },
  "previousPeriod": {
    "date": "2026-08-02",
    "totalSales": "800.00",
    "orderCount": 2
  },
  "changePercent": 50.0,
  "buckets": []
}
```

- `previousPeriod` is the UTC calendar day immediately before `date`.
- `changePercent` is the raw percentage difference between `totals` and
  `previousPeriod` (`(current − previous) / previous × 100`), rounded to
  one decimal. When `previousPeriod.totalSales` is `0`, `changePercent`
  is `null` (never `Infinity`) — the frontend renders its own placeholder.
- `buckets` use the same shape and rules as `timeseries`.

## GET /api/dashboard/analytics/staff-performance

Tier: Advanced — `PRO` and `ENTERPRISE` (feature flag
`advancedAnalytics`), with an active subscription.

Query params:

- `date` — as above.

Example: `GET /api/dashboard/analytics/staff-performance?date=2026-08-03`

Success response — Status: `200`

```json
{
  "date": "2026-08-03",
  "staff": [
    {
      "staffMemberId": "uuid",
      "name": "Ada Obi",
      "sales": { "orderCount": 2, "revenue": "400.00" },
      "inventoryActivity": { "entries": 5, "unitsAdjusted": 12 }
    }
  ]
}
```

Two independent attribution domains, merged into one row per staff
member:

- `sales` — orders with `Order.soldByStaffId` set (the canonical source
  of staff sales attribution going forward), restricted to successful
  sales on the selected date. `revenue` is the sum of `Order.total`.
- `inventoryActivity` — `StockLedgerEntry` rows with
  `performedByStaffId` set on the selected date. `entries` is the entry count;
  `unitsAdjusted` is the sum of `quantityChange` (signed — restocks are
  positive, adjustments can be negative).

A staff member with activity in either domain appears exactly once.
Ranking: `sales.revenue` descending, then `name` ascending. A member
with only inventory activity sorts after any with sales revenue and by
name among equals.

## GET /api/dashboard/analytics/channels

Tier: Advanced — `PRO` and `ENTERPRISE` (feature flag
`advancedAnalytics`), with an active subscription.

Query params:

- `date` — as above.

Example: `GET /api/dashboard/analytics/channels?date=2026-08-03`

Success response — Status: `200`

```json
{
  "date": "2026-08-03",
  "channels": [
    { "source": "POS", "orderCount": 12, "revenue": "15400.00" },
    { "source": "STOREFRONT", "orderCount": 4, "revenue": "3200.00" },
    { "source": "DIRECT", "orderCount": 0, "revenue": "0.00" },
    { "source": "SOCIAL", "orderCount": 0, "revenue": "0.00" },
    { "source": "MARKETPLACE", "orderCount": 0, "revenue": "0.00" },
    { "source": "REFERRAL", "orderCount": 0, "revenue": "0.00" }
  ]
}
```

Revenue-by-channel breakdown over successful sales on the selected date,
grouped by `Order.source` (`OrderSource`: `POS | STOREFRONT | DIRECT |
SOCIAL | MARKETPLACE | REFERRAL`). Every channel appears exactly once,
zero-filled when it has no sales on the selected date, in the order above.
`revenue` is the sum of `Order.total` per channel.

## Error responses

| Status | Code                          | Condition                                                                      |
| ------ | ----------------------------- | ------------------------------------------------------------------------------ |
| `400`  | `INVALID_RANGE`               | Missing or invalid `date`, unsupported weekly granularity, `top` outside 1..50 |
| `401`  | `UNAUTHORIZED`                | Missing/invalid bearer token                                                   |
| `403`  | `INSUFFICIENT_PERMISSIONS`    | Authenticated staff without `analytics.manage`                                 |
| `403`  | `SUBSCRIPTION_INACTIVE`       | No subscription or not ACTIVE/TRIALING (advanced endpoints only)               |
| `403`  | `ADVANCED_ANALYTICS_REQUIRED` | Tier's `advancedAnalytics` flag is false (advanced endpoints only)             |
| `429`  | `RATE_LIMITED`                | —                                                                              |

Error body shape (uniform across the API):

```json
{
  "error": {
    "code": "string",
    "message": "string"
  }
}
```
