# Dashboard expenses

Route group: dashboard
Auth: bearer + store (`authenticate` + `resolveTenant`) +
`authorize("analytics.manage")` (owners pass implicitly)
Rate-limited: writes (`POST`, `PUT`, `DELETE`) at `60_000` window /
`60` requests; reads are not rate-limited

Operating expenses a store records against its profit (the P&L report in
`dashboard-reports.md`). Money values are decimal strings. All timestamps
are UTC ISO-8601.

The trust level is `analytics.manage` — the same permission that gates
the analytics surface — because whoever is trusted to see the store's
revenue and profit is the person who should be recording what affects
it. There is no separate `viewProfit` requirement to _write_ expenses.

## Expense model

- `category` — one of `RENT | TRANSPORT | PACKAGING | SALARIES |
MARKETING | UTILITIES | OTHER`.
- `amount` — `0 < amount <= 99999999.99`, 2 dp.
- `description` — optional free text (max 500 chars).
- `date` — the calendar day the expense belongs to (UTC date, sent as a
  `YYYY-MM-DD` string). Distinct from `createdAt`; the P&L report buckets
  by this field.
- `createdAt` / `updatedAt` — record timestamps.

Every mutation writes a `storeActivityLog` entry (`expense.created`,
`expense.updated`, `expense.deleted`) with `{ expenseId, category,
amount }` in the same transaction as the mutation, attributed to the
acting staff member (owners are unattributed, same as other owner
actions).

## GET /api/dashboard/expenses

Query parameters (all optional):

- `category` — filter to one category.
- `date` — exact `YYYY-MM-DD` calendar date on which the expense was recorded.
- `limit` — `1..100`, default `50`.
- `cursor` — the last `id` of the previous page (uuidv7 ids are
  time-ordered, so `id < cursor` gives the next older page); omitted
  starts at the newest.

Example: `GET /api/dashboard/expenses?date=2026-08-17` returns only expenses
whose `date` is August 17, 2026 (UTC calendar date). Interval filters are not
accepted.

### Success response

Status: `200`

```json
{
  "expenses": [
    {
      "id": "019f…",
      "category": "RENT",
      "amount": "450000.00",
      "description": "August shop rent",
      "date": "2026-08-01",
      "createdAt": "2026-08-01T09:00:00.000Z",
      "updatedAt": "2026-08-01T09:00:00.000Z"
    }
  ],
  "nextCursor": "019f…"
}
```

## POST /api/dashboard/expenses

Body:

```json
{
  "category": "PACKAGING",
  "amount": "2500.00",
  "description": "Nylon bags",
  "date": "2026-08-17"
}
```

### Success response

Status: `201`

```json
{
  "expense": {
    "id": "019f…",
    "category": "PACKAGING",
    "amount": "2500.00",
    "description": "Nylon bags",
    "date": "2026-08-17",
    "createdAt": "2026-08-17T10:00:00.000Z",
    "updatedAt": "2026-08-17T10:00:00.000Z"
  }
}
```

## PUT /api/dashboard/expenses/:expenseId

Partial update; same fields as create (each optional, at least one
required). The response is the updated expense under `{ "expense": … }`,
Status `200`.

## DELETE /api/dashboard/expenses/:expenseId

Status: `204`, empty body. Expense history is deleted outright (the P&L
is a live sum of the rows — there is no append-only requirement on
expenses, unlike ledgers).

## Error responses

| Status | Code                       | Condition                                                                                                 |
| ------ | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`         | Invalid input (bad amount, unknown category, invalid date, empty PUT, or unsupported interval parameters) |
| `401`  | `UNAUTHORIZED`             | Missing/invalid bearer token                                                                              |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated staff without `analytics.manage`                                                            |
| `404`  | `EXPENSE_NOT_FOUND`        | `expenseId` does not exist in this store                                                                  |
| `429`  | `RATE_LIMITED`             | —                                                                                                         |
