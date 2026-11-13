# GET/PUT /api/dashboard/payments/provider

Route group: dashboard
Auth: bearer + store
Authorization: owner only (`requireOwner` — staff roles are rejected, like staff management)
Rate-limited: yes (touches payment data — RULES.md security baseline)

The merchant brings their own Paystack keys. The secret key is encrypted at
rest with the platform master key (`PAYMENT_ENCRYPTION_KEY`); it is NEVER
returned in full by any endpoint after it has been saved — only a masked
indicator. The public key is public by nature and returned in full.

## GET

### Success response

Status: `200`

```json
{
  "configured": true,
  "provider": "paystack",
  "publicKey": "pk_test_xxxxxxxxxxxx",
  "secretKeyMasked": "sk_test_••••abcd — first 6 chars + last 4, middle masked",
  "updatedAt": "2026-08-03T12:00:00.000Z"
}
```

If no keys are configured:

Status: `200`

```json
{
  "configured": false,
  "provider": "paystack",
  "publicKey": null,
  "secretKeyMasked": null,
  "updatedAt": null
}
```

## PUT

### Request

Headers:
- `Content-Type: application/json`

Body:

```json
{
  "provider": "paystack — the only provider this phase",
  "publicKey": "string — required, paystack pk_ prefix",
  "secretKey": "string — required, paystack sk_ prefix"
}
```

Notes:
- `provider` is validated against the known-provider allowlist (zod), not
  free text.
- Both keys are validated with their provider's key-shape rules (e.g.
  `pk_`/`sk_` prefix for Paystack). Test/live mode is detected from the
  prefix (`pk_test_`/`pk_live_`); either is accepted.
- Saving replaces the previous pair wholesale (no dual-key rotation window
  this phase).

### Success response

Status: `200`

```json
{
  "configured": true,
  "provider": "paystack",
  "publicKey": "pk_test_xxxxxxxxxxxx",
  "secretKeyMasked": "sk_test_••••abcd",
  "updatedAt": "2026-08-03T12:00:00.000Z"
}
```

## Error responses

| Status | Condition |
| ------ | --------- |
| `400`  | Invalid input (bad key shape, unknown provider) |
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
