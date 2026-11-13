# POST /api/public/auth/register

Route group: public
Auth: none
Rate-limited: yes

Creates an Account only — the login identity. A new account has no
tenant context yet: `storeId`, `storeName`, `subdomain`, and `role` are
null and `needsOnboarding` is true. The Store and Owner records are
created by the onboarding step (`POST /api/dashboard/onboarding`), so a
first-time user signs up with personal details only — store name and
subdomain are never part of registration.

On success the account is already logged in — access and refresh tokens
are returned in the response — but the email is NOT yet verified: a
single-use verification token is issued, a verification email is sent
to the address, and `verified` is `false`. The user follows the email
link (`FRONTEND_URL/verify?token=<token>`), the frontend presents it at
`POST /api/public/auth/verify`, and only then may the account onboard —
`POST /api/dashboard/onboarding` rejects an unverified account with
`403 VERIFICATION_REQUIRED`. The session works for `/me` and
`/auth/refresh` regardless; verification only gates onboarding.

## Request

Headers:
- `Content-Type: application/json`

Body:

```json
{
  "firstName": "string — required, 1-100 chars",
  "lastName": "string — required, 1-100 chars",
  "phone": "string — required, 7-17 chars of digits (optional leading +, spaces, dashes, parens)",
  "email": "string — valid email, normalized to lowercase",
  "password": "string — min 8 chars, at least one letter and one digit",
  "confirmPassword": "string — must match password"
}
```

## Success response

Status: `201`

```json
{
  "accessToken": "string — JWT, 15-minute lifetime",
  "refreshToken": "string — opaque single-use token, 7-day sliding lifetime",
  "user": {
    "accountId": "string",
    "email": "string",
    "firstName": "string",
    "lastName": "string",
    "phone": "string",
    "role": null,
    "storeId": null,
    "storeName": null,
    "subdomain": null,
    "needsOnboarding": true,
    "verified": false
  }
}
```

- `accessToken`: JWT signed with the backend's access secret. Contains
  `sub` (accountId); `storeId` and `role` claims are null until the
  account is onboarded. Claims are never trusted for tenant resolution —
  the database is authoritative.
- `refreshToken`: opaque string, `rt_<tokenId>.<secret>`. Single-use:
  presenting it at `/auth/refresh` rotates it. The raw value is returned
  exactly once — the backend stores only a hash of the secret.
- `verified`: always `false` on a fresh registration. The verification
  email is sent best-effort (the API never fails registration because a
  mail delivery failed); the user can request a resend at
  `POST /api/dashboard/resend-verification`.

## Error responses

| Status | Code               | Condition                                  |
| ------ | ------------------ | ------------------------------------------ |
| `400`  | `VALIDATION_ERROR` | Malformed body (names, phone, email, password strength, confirmPassword mismatch) |
| `409`  | `EMAIL_TAKEN`      | Email already registered                   |
| `429`  | `RATE_LIMITED`     | Too many requests                          |

Uniform error body shape (see `docs/api-contracts/README.md`).
