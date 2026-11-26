# POST /api/public/auth/verify

Route group: public
Auth: none — the verification token IS the credential (single-use, like
the staff invite token)
Rate-limited: yes

Verifies an account's email address by consuming the single-use token
from the verification email sent at registration (or by a resend). The
email link is `https://<FRONTEND_URL-host>/verify-email?token=<token>`.
The same HTTPS link is registered as an iOS Universal Link and Android
App Link: supported devices open the Brikoh app; otherwise the web app
handles `/verify-email`. The app/web client reads the query token and
submits it in the JSON body below. Opening the URL itself does not
verify the account; verification always occurs through this POST.

After a successful response, the client should show confirmation and
continue to onboarding. An invalid/expired link returns
`VERIFICATION_INVALID`; show a helpful recovery message and offer to
resend verification (the resend endpoint requires an authenticated
session). An already-verified account resolves successfully.

Verification is required before onboarding: `POST
/api/dashboard/onboarding` rejects an unverified account with
`403 VERIFICATION_REQUIRED` (see `dashboard-onboarding.md`).

## Request

Headers:
- `Content-Type: application/json`

Body:

```json
{
  "token": "string — vrf_<token>, parsed from the /verify-email link query"
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
