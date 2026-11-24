# Dashboard reports — P&L and expense breakdown

Route group: dashboard
Auth: bearer + store (`authenticate` + `resolveTenant`) +
`authorize("analytics.manage")` **and** the `viewProfit` permission
(owners hold the full permission set implicitly)
Rate-limited: no (read-only)

The store's profit-and-loss statement plus its expense breakdown, both
with CSV exports (the API's first export endpoints). Money values are
decimal strings. All timestamps are UTC ISO-8601.

The profit figure is the most sensitive number in the store, so the P&L
surface requires `viewProfit` **on top of** `analytics.manage`: a staff
member must be explicitly granted the right to see profit (the Staff &
Roles form assigns `viewProfit`; managers commonly hold it, cashiers do
not). Anyone with `analytics.manage` but without `viewProfit` gets
`403 INSUFFICIENT_PERMISSIONS` on every report endpoint, including the
CSV exports.

## Date filter

Range-based endpoints accept explicit calendar dates in UTC. Use exactly one
of these query shapes:

- One day: `?date=2026-08-17`
- Inclusive range: `?startDate=2026-08-17&endDate=2026-08-23`

Dates must be real calendar days in `YYYY-MM-DD` format. `endDate` is
inclusive. The backend converts the selection to a half-open UTC interval:
midnight at `startDate` through midnight after `endDate`. For example,
`date=2026-08-17` filters timestamps in
`[2026-08-17T00:00:00.000Z, 2026-08-18T00:00:00.000Z)`. This interval
works for timestamped orders and the expense `DATE` column, independent of
the server's local timezone.

The older `start` + `end` UTC ISO-8601 timestamp parameters remain accepted
for existing clients. Their semantics remain half-open (`>= start`, `< end`).
New clients should use the date-only forms so a selected end date is included
in full.

The response's `range.start` and `range.end` are the resolved UTC boundaries;
`range.end` is exclusive. Clients can retain the selected date labels or
derive the inclusive end date by subtracting one UTC calendar day.

**Range errors** are `400 INVALID_RANGE` with a clear, human-readable
message:

| Cause                                 | Message                                                               |
| ------------------------------------- | --------------------------------------------------------------------- |
| A range boundary missing              | "Please provide both a start date and end date."                      |
| Malformed or impossible calendar date | "Enter a date in YYYY-MM-DD format." / "Enter a valid calendar date." |
| Start date after end date             | "The start date must be on or before the end date."                   |
| Legacy timestamps missing UTC offset  | "Dates must be in UTC (include a 'Z' or '+00:00' offset)."            |
| Legacy `start >= end`                 | "The start date must be before the end date."                         |

## GET /api/dashboard/reports/pnl

### Success response

Status: `200`

```json
{
  "range": {
    "start": "2026-08-17T00:00:00.000Z",
    "end": "2026-08-24T00:00:00.000Z"
  },
  "revenue": "1250000.00",
  "cogs": "680000.00",
  "expenses": "125000.00",
  "netProfit": "445000.00",
  "cogsUnpricedLineItems": 2
}
```

Definitions (all money as `toFixed(2)` strings):

- `revenue` — sum of `order.total` for orders in `PAID` or `SHIPPED`
  status created inside the range (the same sale definition the
  analytics module uses).
- `cogs` — cost of goods sold: sum over those orders' line items of
  `product.costPrice × quantity`. A product with no recorded
  `costPrice` contributes **0** — this is a deliberate, surfaced
  tradeoff.
- `expenses` — sum of `amount` on expenses whose `date` falls inside the
  range.
- `netProfit` — `revenue − cogs − expenses`.
- `cogsUnpricedLineItems` — the number of sold line items whose product
  has no `costPrice`. When nonzero, profit is **overstated** by the
  unpriced cost. The UI must show this prominently (banner, not a
  footnote): "N items sold in this range have no recorded cost price;
  profit may be overstated."

## GET /api/dashboard/reports/expenses-by-category

### Success response

Status: `200`

```json
{
  "range": {
    "start": "2026-08-01T00:00:00.000Z",
    "end": "2026-09-01T00:00:00.000Z"
  },
  "categories": [
    { "category": "RENT", "count": 1, "total": "450000.00" },
    { "category": "PACKAGING", "count": 4, "total": "12500.00" }
  ],
  "grandTotal": "462500.00"
}
```

Categories with no expenses in the range are omitted. `categories` is
ordered by `total` descending.

## CSV exports

### GET /api/dashboard/reports/pnl/export.csv

Same query params as the JSON endpoint. One header row plus one data row:

```
start,end,revenue,cogs,expenses,netProfit,cogsUnpricedLineItems
2026-08-17T00:00:00.000Z,2026-08-24T00:00:00.000Z,1250000.00,680000.00,125000.00,445000.00,2
```

### GET /api/dashboard/reports/expenses-by-category/export.csv

One header row plus one data row per category:

```
category,count,total
RENT,1,450000.00
PACKAGING,4,12500.00
```

CSV rules (RFC 4180): fields containing commas, quotes, or line breaks
are quoted with embedded quotes doubled; `\r\n` line endings; money is
exported as plain `toFixed(2)` strings (no thousands separators) so
spreadsheets parse them as numbers.

### Success response

Status: `200`

Headers:

- `Content-Type: text/csv`
- `Content-Disposition: attachment; filename="pnl-2026-08-17_2026-08-23.csv"`
  (for `startDate=2026-08-17&endDate=2026-08-23`; server-generated from
  the selected inclusive UTC dates)

Body: the CSV text.

## GET /api/dashboard/reports/inventory-valuation

The store's stock valued at cost and at retail, right now (no period —
it is a point-in-time snapshot, not a range). Same permission gate as
the P&L (`analytics.manage` + `viewProfit`): it exposes the merchant's
cost basis.

### Success response

Status: `200`

```json
{
  "generatedAt": "2026-08-19T09:00:00.000Z",
  "items": [
    {
      "productId": "019f...",
      "sku": "MUG-001" | null,
      "name": "Ceramic Mug",
      "quantity": 12,
      "costPrice": "450.00" | null,
      "price": "1500.00",
      "valueAtCost": "5400.00",
      "valueAtRetail": "18000.00"
    }
  ],
  "totals": {
    "atCost": "5400.00",
    "atRetail": "18000.00"
  },
  "unpricedProducts": 0
}
```

- `items` — every non-deleted product of the store, ordered by name.
  `quantity` is the sellable stock: the product's own quantity for
  variant-less products, the summed per-variant stock when the product
  has variants (the product-level quantity is inert in that case).
- `valueAtCost` — `quantity × costPrice`; a product with `costPrice`
  `null` contributes `0.00` and counts toward `unpricedProducts`
  (its retail value still counts).
- `valueAtRetail` — `quantity × price`.
- `totals` — the sums of both value columns across all items.
- `generatedAt` — when the snapshot was computed (UTC ISO-8601).

### GET /api/dashboard/reports/inventory-valuation/export.csv

Same snapshot as a CSV file:

```
sku,name,quantity,costPrice,price,valueAtCost,valueAtRetail
MUG-001,Ceramic Mug,12,450.00,1500.00,5400.00,18000.00
```

## Error responses

| Status | Code                       | Condition                                                                     |
| ------ | -------------------------- | ----------------------------------------------------------------------------- |
| `400`  | `INVALID_RANGE`            | Missing, malformed, impossible, mixed, non-UTC legacy, or reversed date range |
| `401`  | `UNAUTHORIZED`             | Missing/invalid bearer token                                                  |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff without `analytics.manage`, or without `viewProfit`                     |

Note: there is no `404` — reports always aggregate over whatever data
exists (an empty range returns zeroed sums, not an error).
