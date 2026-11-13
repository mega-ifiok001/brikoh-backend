# POST /api/public/auth/verify

Route group: public
Auth: none — the verification token IS the credential (single-use, like
the staff invite token)
Rate-limited: yes

Verifies an account's email address by consuming the single-use token
from the verification email sent at registration (or by a resend). The
token travels in the email link — `FRONTEND_URL/verify?token=<token>` —
and is presented by the frontend, which then redirects the user to the
onboarding screen.

Verification is required before onboarding: `POST
/api/dashboard/onboarding` rejects an unverified account with
`403 VERIFICATION_REQUIRED` (see `dashboard-onboarding.md`).

## Request

Headers:
- `Content-Type: application/json`

Body:

```json
{
  "token": "string — vrf_<token>, from the verification email link"
}
```

## Success response

Status: `200`

```json
{
  "verified": true
}
```

- Idempotent: presenting a token for an account that is already verified
  resolves `200` — the token is still consumed when valid, but a stale
  or re-clicked link never errors once the account is verified. A
  token is consumed exactly once; the same token cannot verify a second
  account.

## Error responses

| Status | Code                 | Condition                                        |
| ------ | -------------------- | ------------------------------------------------ |
| `400`  | `VALIDATION_ERROR`   | Missing or malformed token                       |
| `404`  | `VERIFICATION_INVALID` | Unknown, expired, or already-used token (for an account that is not yet verified) |
| `429`  | `RATE_LIMITED`       | Too many requests                                |

Uniform error body shape (see `docs/api-contracts/README.md`).
