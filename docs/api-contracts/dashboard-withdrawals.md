# GET/POST /api/dashboard/wallet/withdrawals

Route group: dashboard
Auth: bearer + store
Authorization: owner only (`requireOwner` — staff roles are rejected, like payment settings)
Rate-limited: yes (touches money data — RULES.md security baseline)

Withdraw money from the wallet to one of the store's bank accounts,
through Paystack transfers. Withdrawals debit the wallet AT REQUEST
TIME (the debit is the concurrency guard — a later `transfer.success`
keeps the money debited, a `transfer.failed` credits it back), and
their lifecycle is settled by Paystack's `transfer.success` /
`transfer.failed` webhooks. Currency is always NGN; amounts are decimal
strings; timestamps are UTC ISO-8601.

## POST — create a withdrawal

### Request

Body:

```json
{
  "bankAccountId": "019fcc2b-e050-729c-81af-82d0ddcbbb87",
  "amount": "5000.00"
}
```

| Field | Type | Required | Meaning |
| ----- | ---- | -------- | ------- |
| `bankAccountId` | string | yes | The destination bank account UUID. |
| `amount` | string | yes | Withdrawal amount, decimal string. Must be ≥ 100.00 and ≤ the available wallet balance. |

### Success response

Status: `201`

```json
{
  "payout": {
    "id": "019fcc2b-e050-729c-81af-82d0ddcbbb87",
    "reference": "wd_1a2b3c4d5e6f7a8b9c0d1e2f",
    "amount": "5000.00",
    "status": "REQUESTED",
    "createdAt": "2026-08-04T09:47:36.001Z",
    "processedAt": null,
    "bankAccount": {
      "id": "019fcc2b-e050-729c-81af-82d0ddcbbb87",
      "maskedAccountNumber": "0123••••6789",
      "bankName": "Guaranty Trust Bank",
      "accountName": "Brikoh Ventures Ltd"
    }
  }
}
```

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `id` | string | Payout UUID (uuid v7). |
| `reference` | string | Backend-generated payout reference (`wd_…`), sent to Paystack. |
| `amount` | string | The requested amount. |
| `status` | string | `REQUESTED` \| `PROCESSING` \| `SUCCESS` \| `FAILED`. After this call it is `REQUESTED` (Paystack initiated but not yet confirmed) or `PROCESSING` (Paystack accepted the transfer). |
| `createdAt` | string | UTC ISO-8601. |
| `processedAt` | string \| null | When the transfer was confirmed SUCCESS/FAILED (via webhook), else `null`. |
| `bankAccount` | object | The destination (id + masked number + names). |

Payout lifecycle:

| Status | Meaning |
| ------ | ------- |
| `REQUESTED` | Wallet debited, transfer being sent to Paystack. |
| `PROCESSING` | Paystack accepted the transfer; awaiting confirmation. |
| `SUCCESS` | `transfer.success` webhook confirmed the money moved. |
| `FAILED` | `transfer.failed` webhook (or a provider error at request time) — the debited amount was credited back to the wallet as a `WITHDRAWAL_REVERSAL` ledger entry. |

Notes:
- The wallet is debited atomically at request time inside a single
  transaction with the payout row; concurrent withdrawals cannot
  overdraw (the debit is a conditional balance check).
- If Paystack rejects the transfer at request time, the payout is
  created as `FAILED`, the debited amount is credited straight back
  (automatic reversal), and the response still returns `201` with the
  FAILED payout — no money ever left the wallet.
- Final `SUCCESS`/`FAILED` is always the webhook's word, never the
  request's.

## GET — list withdrawals

### Request

Query params:
- `cursor: string? — the id of the last withdrawal of the previous page (uuidv7 ids are time-ordered, so id < cursor)`
- `limit: number? — page size, default 20, max 100`

### Success response

Status: `200`

```json
{
  "withdrawals": [
    {
      "id": "019fcc2b-e050-729c-81af-82d0ddcbbb87",
      "reference": "wd_1a2b3c4d5e6f7a8b9c0d1e2f",
      "amount": "5000.00",
      "status": "SUCCESS",
      "createdAt": "2026-08-04T09:47:36.001Z",
      "processedAt": "2026-08-04T09:48:12.000Z",
      "bankAccount": {
        "id": "019fcc2b-e050-729c-81af-82d0ddcbbb87",
        "maskedAccountNumber": "0123••••6789",
        "bankName": "Guaranty Trust Bank",
        "accountName": "Brikoh Ventures Ltd"
      }
    }
  ],
  "nextCursor": "019fcc2a-e050-729c-81af-82d0ddcbbb86"
}
```

`nextCursor` is `null` on the last page. `withdrawals` is ordered
newest-first.

## Error responses

| Status | Condition |
| ------ | --------- |
| `400`  | `VALIDATION_ERROR` — malformed input |
| `400`  | `WITHDRAWAL_BELOW_MINIMUM` — amount < 100.00 |
| `401`  | Unauthenticated |
| `403`  | Unauthorized — staff role, owner required |
| `404`  | `BANK_ACCOUNT_NOT_FOUND` — no such destination account for this store |
| `409`  | `INSUFFICIENT_WALLET_BALANCE` — amount exceeds the available balance |
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
