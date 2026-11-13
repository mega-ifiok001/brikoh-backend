# GET/POST /api/dashboard/settings/bank-accounts

Route group: dashboard

Auth:

- Bearer + store (`resolveTenant`)
- Permission: `settings.manage` (owners pass implicitly)
- Rate-limited: no

Merchant **settlement** bank accounts — the accounts a store accepts manual
bank-transfer payments into. These are distinct from the wallet withdrawal
accounts documented in `dashboard-bank-accounts.md` (that endpoint is
`/api/dashboard/wallet/bank-accounts`). A store's **default** account here is
the one snapshotted onto a `bank_transfer` checkout (`public-checkout.md`)
and advertised via `availablePaymentMethods` on the storefront
(`public-storefront.md`); without one, a `bank_transfer` checkout returns
`409 BANK_ACCOUNT_NOT_CONFIGURED`.

## POST /api/dashboard/settings/bank-accounts

Creates a merchant bank account. Setting `isDefault: true` demotes any
existing default (a store has at most one default).

### Request body

```json
{
  "accountName": "Adebayo Idowu",
  "bankName": "Access Bank",
  "accountNumber": "0123456789",
  "isDefault": true
}
```

- `accountName` — `1..200` chars, required.
- `bankName` — `1..200` chars, required.
- `accountNumber` — exactly **10 digits** (`^\d{10}$`), required (Nigerian
  bank format).
- `isDefault` — optional boolean; defaults to `false`.

### Success response — `201`

```json
{
  "id": "string",
  "accountName": "Adebayo Idowu",
  "bankName": "Access Bank",
  "accountNumber": "0123456789",
  "isDefault": true
}
```

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `400`  | `VALIDATION_ERROR` | Missing field, or `accountNumber` not exactly 10 digits |
| `401`  | `UNAUTHORIZED` | Missing/invalid token |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `settings.manage` |

## GET /api/dashboard/settings/bank-accounts

Lists the store's merchant accounts, default first.

### Success response — `200`

```json
{
  "bankAccounts": [
    {
      "id": "string",
      "accountName": "Adebayo Idowu",
      "bankName": "Access Bank",
      "accountNumber": "0123456789",
      "isDefault": true
    }
  ]
}
```

An empty list is `{ "bankAccounts": [] }`.

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `401`  | `UNAUTHORIZED` | Missing/invalid token |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `settings.manage` |

Uniform error body shape (see `docs/api-contracts/README.md`).
