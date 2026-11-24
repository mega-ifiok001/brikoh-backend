# Dashboard transactions

Base path: `/api/dashboard/transactions`

Auth: bearer access token + resolved store membership.

Permission: `analytics.manage` and `viewProfit` for staff; owners pass
implicitly. This is the existing reports permission boundary. The endpoint
never returns a full bank account number.

The feed combines sales, credit repayments, invoice payments, withdrawals,
wallet reversals, and wallet adjustments. In `all` view, Paystack sale credits
and payout debits are represented by their related order or payout so they
are not duplicated. `wallet` view reads the append-only wallet ledger only.
POS cash, transfer, and credit sales remain visible in `all` view.

## GET /api/dashboard/transactions

### Query parameters

- `from` and `to` — required inclusive `YYYY-MM-DD` dates, interpreted in
  `Africa/Lagos`. The maximum range is 367 calendar dates.
- `view` — `all` (default) or `wallet`.
- `direction` — optional `IN` or `OUT`.
- `type` — optional `SALE | CREDIT_REPAYMENT | INVOICE_PAYMENT | WITHDRAWAL |
WITHDRAWAL_REVERSAL | WALLET_ADJUSTMENT`.
- `status` — optional `PENDING | PROCESSING | SUCCESS | FAILED | REFUNDED`.
- `method` — optional `CASH | TRANSFER | CREDIT | CARD | PAYSTACK | MANUAL`.
- `branchId` — optional branch UUID.
- `search` — optional substring of reference, order/invoice number, customer
  name, or amount.
- `limit` — `1..100`, default `50`.
- `cursor` — opaque cursor from the previous page.

Example:

```http
GET /api/dashboard/transactions?from=2026-08-01&to=2026-08-31&view=all&limit=50
Authorization: Bearer <access-token>
```

`from` and `to` are local calendar labels; queries are converted to UTC
boundaries for the `Africa/Lagos` day. All results are newest first.

### Response

```json
{
  "transactions": [
    {
      "id": "ORDER:019f0000-0000-7000-8000-000000000001",
      "type": "SALE",
      "direction": "IN",
      "title": "Sale ORD-0042",
      "orderNumber": "ORD-0042",
      "customerName": "Ada Obi",
      "paymentMethod": "PAYSTACK",
      "grossAmount": "25000.00",
      "feeAmount": "250.00",
      "netAmount": "24750.00",
      "amount": "25000.00",
      "currency": "NGN",
      "status": "SUCCESS",
      "reference": "ord_...",
      "createdAt": "2026-08-17T09:15:00.000Z",
      "initiatedAt": "2026-08-17T09:10:00.000Z",
      "paidAt": "2026-08-17T09:15:00.000Z",
      "settledAt": "2026-08-17T09:15:00.000Z",
      "statusExplanation": null,
      "branchId": "019f0000-0000-7000-8000-000000000002",
      "balanceAfter": "100000.00",
      "linkedRecords": {
        "orderId": "019f0000-0000-7000-8000-000000000001",
        "invoiceId": null,
        "customerId": "019f0000-0000-7000-8000-000000000003"
      },
      "bankAccount": null
    }
  ],
  "nextCursor": null,
  "total": 1,
  "range": {
    "from": "2026-08-01",
    "to": "2026-08-31",
    "timeZone": "Africa/Lagos"
  },
  "summary": { "moneyIn": "24750.00", "moneyOut": "0.00", "net": "24750.00" },
  "dailyTotals": [
    {
      "date": "2026-08-17",
      "moneyIn": "24750.00",
      "moneyOut": "0.00",
      "net": "24750.00"
    }
  ],
  "activeFilterCount": 0
}
```

All money fields are decimal strings; the API does not convert money to
floating-point numbers. `feeAmount` and `netAmount` are `null` when the
provider did not supply fee data. Newly received Paystack charge fees and
withdrawal fees are stored when present in signed provider events. Legacy
charges without stored fee data remain `null`.

For credit sales, `grossAmount` is the sale value and `amount`/`netAmount`
show the amount actually paid so far. An unpaid balance is represented as a
pending sale; later credit repayments appear as separate incoming entries.
`settledAt` is the time funds were credited to the wallet when that ledger
entry exists. Provider batch settlement times are not otherwise available.

`summary` and `dailyTotals` are calculated across all matching transactions,
before cursor pagination. The selected filters apply to both the page and
the summaries. Dates in `dailyTotals` are grouped in `Africa/Lagos`.

### Cursor pagination

Pass `nextCursor` as `cursor` with the same other filters to fetch the next
page. A cursor is scoped to the current filtered result; changing the date
range or filters requires starting again without a cursor.

## GET /api/dashboard/transactions/:transactionId

Returns one transaction with its full feed/detail fields. Use the `id` from a
feed item as `transactionId`, URL-encoding the colon if required. IDs are
prefixed by source (`ORDER:`, `PAYOUT:`, `CREDIT_REPAYMENT:`,
`INVOICE_PAYMENT:`, or `WALLET:`). The lookup is scoped to the authenticated
store.

## GET /api/dashboard/transactions/export.csv

Accepts the same date and filter parameters as the feed, except `cursor` and
`limit`. Returns a CSV statement for the selected range and filters.

Example:

```http
GET /api/dashboard/transactions/export.csv?from=2026-08-01&to=2026-08-31&view=all
Authorization: Bearer <access-token>
```

The response uses `Content-Type: text/csv` and a date-range filename.

## Errors

| Status | Code                                         | Condition                                          |
| ------ | -------------------------------------------- | -------------------------------------------------- |
| `400`  | `INVALID_TRANSACTION_FILTER`                 | Invalid date, filter, range, or pagination limit   |
| `400`  | `INVALID_TRANSACTION_CURSOR`                 | Malformed, stale, or filter-mismatched cursor      |
| `401`  | `UNAUTHORIZED`                               | Missing or invalid access token                    |
| `403`  | `INSUFFICIENT_PERMISSIONS` / `ACCESS_DENIED` | Missing `analytics.manage` or `viewProfit`         |
| `404`  | `TRANSACTION_NOT_FOUND`                      | Transaction is not part of the authenticated store |
