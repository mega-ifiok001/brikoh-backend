# GET /api/dashboard/wallet

Route group: dashboard
Auth: bearer + store
Authorization: owner only (`requireOwner` — staff roles are rejected, like payment settings)
Rate-limited: yes (touches money data — RULES.md security baseline)

The store's wallet overview: the available balance, money in flight,
money withdrawn, and the most recent ledger movements. The wallet is
fed exclusively by CARD/online orders paid through Paystack (the
`charge.success` webhook); CASH/TRANSFER/CREDIT sales never touch it.
Currency is always `NGN` (Paystack transfers are NGN-only). All amounts
are decimal strings; timestamps are UTC ISO-8601.

## Request

Headers:
- `Authorization: Bearer <token>`

No path or query params.

## Success response

Status: `200`

```json
{
  "wallet": {
    "currency": "NGN",
    "available": "1234.56",
    "pending": "500.00",
    "withdrawn": "2500.00",
    "totalCredits": "4234.56"
  },
  "recentEntries": [
    {
      "id": "019fcc2b-e050-729c-81af-82d0ddcbbb87",
      "type": "CREDIT",
      "source": "ORDER_PAYMENT",
      "amount": "1234.56",
      "balanceAfter": "1234.56",
      "orderId": "019fcc2a-e050-729c-81af-82d0ddcbbb86",
      "payoutId": null,
      "createdAt": "2026-08-04T09:47:36.001Z"
    }
  ]
}
```

Per-field meanings:

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `wallet.currency` | string | Always `NGN`. |
| `wallet.available` | string | Current spendable balance (the wallet ledger's balance). |
| `wallet.pending` | string | Sum of withdrawals requested or in flight (REQUESTED/PROCESSING) — already debited from `available`. |
| `wallet.withdrawn` | string | Sum of withdrawals that completed successfully (SUCCESS). |
| `wallet.totalCredits` | string | Sum of every credit entry ever (online order payments + reversals). |
| `recentEntries[]` | array | The 25 most recent ledger entries, newest first. |
| `recentEntries[].id` | string | Ledger entry UUID (uuid v7). |
| `recentEntries[].type` | string | `CREDIT` (adds) \| `DEBIT` (subtracts). |
| `recentEntries[].source` | string | Why the entry exists: `ORDER_PAYMENT` \| `WITHDRAWAL` \| `WITHDRAWAL_REVERSAL` \| `ADJUSTMENT`. |
| `recentEntries[].amount` | string | Entry amount (always positive; the `type` says which way it moved). |
| `recentEntries[].balanceAfter` | string | Wallet balance immediately after this entry — the append-only audit trail. |
| `recentEntries[].orderId` | string \| null | The order whose payment produced a `ORDER_PAYMENT` credit, else `null`. |
| `recentEntries[].payoutId` | string \| null | The payout a `WITHDRAWAL`/`WITHDRAWAL_REVERSAL` entry belongs to, else `null`. |
| `recentEntries[].createdAt` | string | UTC ISO-8601. |

Notes:
- The wallet ledger is append-only: entries can never be edited or
  deleted, and every entry carries the balance after it was applied.
- A store with no wallet activity yet returns `available: "0.00"` and
  an empty `recentEntries` array — the field set is always complete.
- `pending` is informational: those amounts are already excluded from
  `available` (withdrawals debit the wallet at request time).

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
