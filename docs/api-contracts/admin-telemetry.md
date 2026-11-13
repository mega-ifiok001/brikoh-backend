# Admin telemetry

Route group: admin. Auth: admin bearer. Permission: `admin:telemetry.view` (`SUPER_ADMIN` only).

All ranges are required UTC ISO-8601 timestamps and use the half-open interval `[start, end)`. The cohort is stores created inside that interval.

## GET /api/admin/telemetry/funnel

Returns the registration cohort's lifecycle funnel:

- `registered` — `Store.createdAt`.
- `firstProductPublished` — stores with a published product. Its timestamp is `MIN(Product.updatedAt)` where status is `PUBLISHED`; this is an approximation because product status-transition history is not stored.
- `firstOrderPlaced` — `MIN(Order.createdAt)` for any order status.
- `firstOrderPaid` — `MIN(Order.paidAt)` where non-null. This is exact for payments recorded after the paidAt migration.
- `upgradedToPaidTier` — a first Pro/Enterprise subscription preceded by a Starter subscription for the same store.

Each step returns `count` and `conversionFromPrevious` (percentage, one decimal); the first step is `100`, and a step whose predecessor has zero stores returns `null`.

```json
{
  "range": { "start": "2026-08-01T00:00:00.000Z", "end": "2026-09-01T00:00:00.000Z" },
  "steps": [{ "key": "registered", "count": 10, "conversionFromPrevious": 100 }]
}
```

## GET /api/admin/telemetry/median-time-to-first-order

Uses the same registration cohort. Returns the exact median of non-negative `firstOrder.createdAt - Store.createdAt` durations, in whole seconds. For an even count it is the arithmetic mean of the two central durations; `medianSeconds` is null if no cohort store has an order.

```json
{
  "range": { "start": "2026-08-01T00:00:00.000Z", "end": "2026-09-01T00:00:00.000Z" },
  "cohortStoreCount": 10,
  "storesWithFirstOrder": 6,
  "medianSeconds": 7200
}
```
