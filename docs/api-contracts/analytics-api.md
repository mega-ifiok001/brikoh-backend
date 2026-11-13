# Analytics endpoints

Route group: dashboard
Auth: bearer + store (authenticate + resolveTenant)
Permission: `analytics.manage` (owners pass implicitly)
Rate-limited: no

Base path: `/api/dashboard/analytics`

All five endpoints share the same range semantics:

- `start` and `end` are required, UTC ISO-8601 timestamps (must carry a
  `Z` or `+00:00` offset — local-timezone offsets are rejected).
- The range is half-open: `createdAt >= start` AND `createdAt < end`
  (an order exactly at `end` is excluded; exactly at `start` is included).
- A range may span at most 366 days.
- All money values are returned as strings (`Decimal.toFixed(2)`), never
  floats.
- Every aggregation counts only **successful sales**: orders whose status
  is `PAID` or `SHIPPED`. PENDING / FAILED / CANCELLED / REFUNDED orders
  are never counted.

## GET /api/dashboard/analytics/summary

Tier: Basic — available on every tier, including stores with no
subscription.

Query params:
- `start: string (UTC ISO-8601) — range start, inclusive — required`
- `end: string (UTC ISO-8601) — range end, exclusive — required`
- `top: integer 1..50 — number of best sellers to return (default 5)`

Success response — Status: `200`

```json
{
  "range": {
    "start": "2026-08-01T00:00:00.000Z",
    "end": "2026-08-08T00:00:00.000Z"
  },
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
across successful sales in the range; `revenue` is the sum of
`quantity × unitPriceAtPurchase` (prices captured at purchase time, never
re-read from the product). A range with no orders returns
`totalSales: "0.00"`, `orderCount: 0`, `bestSellers: []`.

## GET /api/dashboard/analytics/timeseries

Tier: Basic — available on every tier, including stores with no
subscription.

Query params:
- `start`, `end` — as above.
- `granularity: "daily" | "weekly"` (default `daily`)

Success response — Status: `200`

```json
{
  "range": {
    "start": "2026-08-01T00:00:00.000Z",
    "end": "2026-08-08T00:00:00.000Z"
  },
  "granularity": "daily",
  "buckets": [
    {
      "start": "2026-08-01T00:00:00.000Z",
      "end": "2026-08-02T00:00:00.000Z",
      "totalSales": "0.00",
      "orderCount": 0
    }
  ]
}
```

Bucket rules (deterministic across time zones — all math is UTC):

- Daily buckets are aligned to UTC midnight; weekly buckets are aligned
  to Monday 00:00:00 UTC (ISO weeks).
- Every bucket in the range is present, **zero-filled** — a day with no
  orders is `totalSales: "0.00"`, `orderCount: 0`, never omitted.
- A bucket's `start`/`end` are full UTC boundaries; orders are assigned
  to the UTC day/week of their `createdAt`, restricted to the range.
  An order at `T23:59:59Z` lands in its day's bucket; `T00:00:01Z` in the
  next day's.

## GET /api/dashboard/analytics/trends

Tier: Advanced — `PRO` and `ENTERPRISE` (feature flag
`advancedAnalytics`), with an active subscription.

Query params:
- `start`, `end`, `granularity` — as above.

Success response — Status: `200`

```json
{
  "range": {
    "start": "2026-08-01T00:00:00.000Z",
    "end": "2026-08-08T00:00:00.000Z"
  },
  "granularity": "daily",
  "totals": { "totalSales": "1200.00", "orderCount": 3 },
  "previousPeriod": {
    "start": "2026-07-25T00:00:00.000Z",
    "end": "2026-08-01T00:00:00.000Z",
    "totalSales": "800.00",
    "orderCount": 2
  },
  "changePercent": 50.0,
  "buckets": []
}
```

- `previousPeriod` is the equally sized window immediately preceding
  `start` (`[start − (end − start), start)`).
- `changePercent` is the raw percentage difference between `totals` and
  `previousPeriod` (`(current − previous) / previous × 100`), rounded to
  one decimal. When `previousPeriod.totalSales` is `0`, `changePercent`
  is `null` (never `Infinity`) — the frontend renders its own placeholder.
- `buckets` use the same shape and rules as `timeseries`.

## GET /api/dashboard/analytics/staff-performance

Tier: Advanced — `PRO` and `ENTERPRISE` (feature flag
`advancedAnalytics`), with an active subscription.

Query params:
- `start`, `end` — as above.

Success response — Status: `200`

```json
{
  "range": {
    "start": "2026-08-01T00:00:00.000Z",
    "end": "2026-08-08T00:00:00.000Z"
  },
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
  sales in the range. `revenue` is the sum of `Order.total`.
- `inventoryActivity` — `StockLedgerEntry` rows with
  `performedByStaffId` set in the range. `entries` is the entry count;
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
- `start`, `end` — as above.

Success response — Status: `200`

```json
{
  "range": {
    "start": "2026-08-01T00:00:00.000Z",
    "end": "2026-08-08T00:00:00.000Z"
  },
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

Revenue-by-channel breakdown over successful sales in the range,
grouped by `Order.source` (`OrderSource`: `POS | STOREFRONT | DIRECT |
SOCIAL | MARKETPLACE | REFERRAL`). Every channel appears exactly once,
zero-filled when it has no sales in the range, in the order above.
`revenue` is the sum of `Order.total` per channel.

## Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `400`  | `INVALID_RANGE` | Missing/non-UTC `start`/`end`, `start >= end`, range longer than 366 days, unknown `granularity`, `top` outside 1..50 |
| `401`  | `UNAUTHORIZED` | Missing/invalid bearer token |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated staff without `analytics.manage` |
| `403`  | `SUBSCRIPTION_INACTIVE` | No subscription or not ACTIVE/TRIALING (advanced endpoints only) |
| `403`  | `ADVANCED_ANALYTICS_REQUIRED` | Tier's `advancedAnalytics` flag is false (advanced endpoints only) |
| `429`  | `RATE_LIMITED` | — |

Error body shape (uniform across the API):

```json
{
  "error": {
    "code": "string",
    "message": "string"
  }
}
```
