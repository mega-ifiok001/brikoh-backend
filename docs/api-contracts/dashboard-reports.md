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

Range-based report endpoints accept one calendar date: `?date=2026-08-17`.
Dates must be real calendar days in `YYYY-MM-DD` format. The backend filters
the full UTC day, from midnight on the selected date up to (but not including)
midnight the next day. This works for timestamped orders and the expense
`DATE` column, independent of the server's local timezone. Range parameters
such as `start`, `end`, `startDate`, and `endDate` are no longer accepted.

Responses echo the selected `date` as `YYYY-MM-DD`.

**Range errors** are `400 INVALID_RANGE` with a clear, human-readable
message:

| Cause                                 | Message                                                               |
| ------------------------------------- | --------------------------------------------------------------------- |
| `date` missing                        | "Please provide a date in YYYY-MM-DD format."                         |
| Malformed or impossible calendar date | "Enter a date in YYYY-MM-DD format." / "Enter a valid calendar date." |
| Range parameter supplied              | "Only the date query parameter is supported."                         |

## GET /api/dashboard/reports/pnl

### Success response

Status: `200`

```json
{
  "date": "2026-08-17",
  "revenue": "1250000.00",
  "cogs": "680000.00",
  "expenses": "125000.00",
  "netProfit": "445000.00",
  "cogsUnpricedLineItems": 2
}
```

Definitions (all money as `toFixed(2)` strings):

- `revenue` — sum of `order.total` for orders in `PAID` or `SHIPPED`
  status created on the selected date (the same sale definition the
  analytics module uses).
- `cogs` — cost of goods sold: sum over those orders' line items of
  `product.costPrice × quantity`. A product with no recorded
  `costPrice` contributes **0** — this is a deliberate, surfaced
  tradeoff.
- `expenses` — sum of `amount` on expenses whose `date` matches the
  selected date.
- `netProfit` — `revenue − cogs − expenses`.
- `cogsUnpricedLineItems` — the number of sold line items whose product
  has no `costPrice`. When nonzero, profit is **overstated** by the
  unpriced cost. The UI must show this prominently (banner, not a
  footnote): "N items sold on this date have no recorded cost price;
  profit may be overstated."

## GET /api/dashboard/reports/expenses-by-category

### Success response

Status: `200`

```json
{
  "date": "2026-08-17",
  "categories": [
    { "category": "RENT", "count": 1, "total": "450000.00" },
    { "category": "PACKAGING", "count": 4, "total": "12500.00" }
  ],
  "grandTotal": "462500.00"
}
```

Categories with no expenses on the selected date are omitted. `categories` is
ordered by `total` descending.

## CSV exports

### GET /api/dashboard/reports/pnl/export.csv

Same query params as the JSON endpoint. One header row plus one data row:

```
date,revenue,cogs,expenses,netProfit,cogsUnpricedLineItems
2026-08-17,1250000.00,680000.00,125000.00,445000.00,2
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
- `Content-Disposition: attachment; filename="pnl-2026-08-17_2026-08-17.csv"`
  (for `date=2026-08-17`; server-generated from the selected UTC date)

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

| Status | Code                       | Condition                                                 |
| ------ | -------------------------- | --------------------------------------------------------- |
| `400`  | `INVALID_RANGE`            | Missing or invalid date, or unsupported range parameters  |
| `401`  | `UNAUTHORIZED`             | Missing/invalid bearer token                              |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff without `analytics.manage`, or without `viewProfit` |

Note: there is no `404` — reports always aggregate over whatever data
exists (an empty range returns zeroed sums, not an error).
