# GET/POST /api/dashboard/wallet/bank-accounts, DELETE /api/dashboard/wallet/bank-accounts/:bankAccountId

Route group: dashboard
Auth: bearer + store
Authorization: owner only (`requireOwner` — staff roles are rejected, like payment settings)
Rate-limited: yes (touches money data — RULES.md security baseline)

The merchant's withdrawal destinations. On create, the backend resolves
the account with Paystack (POST /bank/resolve — the resolved account
name is the source of truth), creates a Paystack transfer recipient
(POST /transferrecipient), and stores ONLY the recipient code plus a
masked account number — the full account number never touches our
database. Currency is always NGN.

## GET — list bank accounts

### Request

Headers:
- `Authorization: Bearer <token>`

No path or query params.

### Success response

Status: `200`

```json
{
  "bankAccounts": [
    {
      "id": "019fcc2b-e050-729c-81af-82d0ddcbbb87",
      "accountName": "Brikoh Ventures Ltd",
      "bankName": "Guaranty Trust Bank",
      "bankCode": "058",
      "maskedAccountNumber": "0123••••6789",
      "isDefault": true,
      "createdAt": "2026-08-04T09:47:36.001Z"
    }
  ]
}
```

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `id` | string | Bank account UUID (uuid v7). |
| `accountName` | string | The account name as resolved by Paystack. |
| `bankName` | string | Human-readable bank name. |
| `bankCode` | string | Paystack bank code (3 digits). |
| `maskedAccountNumber` | string | First 4 + `••••` + last 4; the real number is never stored. |
| `isDefault` | boolean | Preferred destination (pre-selected in the withdrawal form). |
| `createdAt` | string | UTC ISO-8601. |

An empty list is `{ "bankAccounts": [] }`.

## POST — create a bank account

### Request

Body:

```json
{
  "accountName": "Brikoh Ventures Ltd",
  "accountNumber": "0123456789",
  "bankName": "Guaranty Trust Bank",
  "bankCode": "058",
  "isDefault": true
}
```

| Field | Type | Required | Meaning |
| ----- | ---- | -------- | ------- |
| `accountName` | string | no | Expected account name. When supplied, it must match Paystack's resolved name (case-insensitive) or the create fails — a typo guard. When omitted, the resolved name is used. |
| `accountNumber` | string | yes | 10-digit NUBAN. |
| `bankName` | string | yes | Human-readable bank name (client's bank list). |
| `bankCode` | string | yes | 3-digit Paystack bank code. |
| `isDefault` | boolean | no | Defaults `false`. Setting it clears `isDefault` on the store's other accounts. |

### Success response

Status: `201`

```json
{
  "bankAccount": {
    "id": "019fcc2b-e050-729c-81af-82d0ddcbbb87",
    "accountName": "Brikoh Ventures Ltd",
    "bankName": "Guaranty Trust Bank",
    "bankCode": "058",
    "maskedAccountNumber": "0123••••6789",
    "isDefault": true,
    "createdAt": "2026-08-04T09:47:36.001Z"
  }
}
```

## DELETE — remove a bank account

### Request

Path params:
- `bankAccountId: string — the bank account UUID`

### Success response

Status: `204` (no body).

An account that has ever been used by a withdrawal cannot be deleted —
financial history must keep its attribution.

## Error responses

| Status | Condition |
| ------ | --------- |
| `400`  | `VALIDATION_ERROR` — malformed input (bad NUBAN/bank code) |
| `400`  | `BANK_ACCOUNT_UNRESOLVED` — Paystack could not resolve the account, or `accountName` does not match the resolved name |
| `401`  | Unauthenticated |
| `403`  | Unauthorized — staff role, owner required |
| `404`  | `BANK_ACCOUNT_NOT_FOUND` — no such account for this store (DELETE) |
| `409`  | `BANK_ACCOUNT_HAS_PAYOUTS` — the account has withdrawal history and cannot be deleted (DELETE) |
| `429`  | Rate limited |
| `502`  | `PAYMENT_PROVIDER_ERROR` — Paystack rejected the resolve/recipient call |

Error body shape (uniform across the API):

```json
{
  "error": {
    "code": "string",
    "message": "string"
  }
}
```
