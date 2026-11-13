# GET /api/dashboard/payments/settlements

Route group: dashboard
Auth: bearer + store
Authorization: owner only (`requireOwner` — staff roles are rejected, like payment settings)
Rate-limited: yes (touches payment data — RULES.md security baseline)

Returns, per paid order, the actual settlement state from Paystack's
transaction/settlement API, called with the merchant's own (decrypted) keys.
All timestamps are UTC ISO-8601. When Paystack's data is unavailable, the
response says so explicitly — the `settlement` field is NEVER omitted.

## Request

Headers:
- `Authorization: Bearer <token>`

No path or query params.

## Success response

Status: `200`

```json
{
  "settlements": [
    {
      "orderId": "019fcc2b-e050-729c-81af-82d0ddcbbb87",
      "reference": "ord_1a2b3c4d5e6f7a8b9c0d1e2f",
      "total": "1234.56",
      "currency": "NGN",
      "transactionStatus": "success",
      "paidAt": "2026-08-04T09:47:36.001Z",
      "settlement": {
        "status": "UNAVAILABLE",
        "settledAt": null,
        "detail": "string — explicit reason; see notes"
      }
    }
  ]
}
```

Per-order fields:

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `orderId` | string | The order's UUID (uuid v7). |
| `reference` | string | The order's payment reference (`ord_…`), echoed to Paystack. |
| `total` | string | Decimal total captured at purchase (never client-supplied). |
| `currency` | string | The store's profile currency (ISO-4217). |
| `transactionStatus` | string | From Paystack's `GET /transaction/verify/:reference`: `success` \| `failed` \| `pending` \| `unknown` \| `unavailable`. `unavailable` means Paystack could not be reached or returned no usable data. |
| `paidAt` | string \| null | When Paystack reports the payment, UTC ISO-8601. `null` when unknown/unavailable. |
| `settlement.status` | string | `SETTLED` when Paystack's data confirms the money reached the merchant; otherwise `UNAVAILABLE`. |
| `settlement.settledAt` | string \| null | UTC ISO-8601 when known, else `null`. |
| `settlement.detail` | string | Explicit explanation whenever the state is not `SETTLED` — e.g. `"Paystack data unavailable: <provider error>"` or `"Paystack does not expose per-transaction settlement data"`. |

Notes:
- Only orders with status `PAID` are included, ordered by `createdAt` desc.
- Each order's transaction is queried live from Paystack with the store's
  secret key — the response reflects Paystack's data at request time, never a
  cached guess.
- Settlement is a batch-level concept on Paystack: there is no
  per-transaction settlement reference. `SETTLED` is reported only when
  Paystack's data confirms it; otherwise the field says `UNAVAILABLE` with a
  `detail` explaining why. The field is always present.
- If Paystack is unreachable or errors, that order's
  `transactionStatus`/`paidAt`/`settlement` reflect it explicitly; the
  endpoint itself still returns `200` (the merchant's own data is intact).

## Error responses

| Status | Condition |
| ------ | --------- |
| `401`  | Unauthenticated |
| `403`  | Unauthorized — staff role, owner required |
| `429`  | Rate limited |

Error body shape (uniform across the API):

```json
{
  "error": {
    "code": "string",
    "message": "string"
  }
}
```
