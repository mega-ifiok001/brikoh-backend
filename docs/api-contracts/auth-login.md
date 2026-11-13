# POST /api/public/auth/login

Route group: public
Auth: none
Rate-limited: yes

Authenticates an account by email + password and returns a token pair.
The user object carries the account's tenant context when it has one;
an account that registered but has not onboarded yet logs in
successfully with `needsOnboarding: true` and null tenant fields —
login never rejects a validly credentialed account for missing a store.

## Request

Headers:
- `Content-Type: application/json`

Body:

```json
{
  "email": "string — valid email, normalized to lowercase",
  "password": "string"
}
```

## Success response

Status: `200`

```json
{
  "accessToken": "string — JWT, 15-minute lifetime",
  "refreshToken": "string — opaque single-use token, 7-day sliding lifetime",
  "user": {
    "accountId": "string",
    "email": "string",
    "firstName": "string | null",
    "lastName": "string | null",
    "phone": "string | null",
    "role": "OWNER | ADMIN | MANAGER | STAFF | null",
    "storeId": "string | null",
    "storeName": "string | null",
    "subdomain": "string | null",
    "needsOnboarding": "boolean",
    "verified": "boolean — email verification state"
  }
}
```

- `role` is `OWNER` when the account owns the store, otherwise the staff
  member's role. An account that is both owner and staff resolves to
  `OWNER`. Before onboarding the role and tenant fields are `null` and
  `needsOnboarding` is `true`.
- `verified` is `true` once the account's email has been verified via
  `POST /api/public/auth/verify`; login itself never rejects an
  unverified account (verification only gates onboarding).
- Accounts created via Google sign-in (see `/auth/google`) have no
  password: password login returns the identical `INVALID_CREDENTIALS`
  response for them, and they keep signing in with the Google button.
- `accessToken` claims: `sub` (accountId), `storeId`, `role`,
  `staffMemberId` (all null before onboarding; claims are never trusted
  for tenant resolution).
- `refreshToken` is single-use — see `/auth/refresh`.

## Error responses

| Status | Code                  | Condition                                          |
| ------ | --------------------- | -------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Malformed body                                     |
| `401`  | `INVALID_CREDENTIALS` | Unknown email or wrong password (identical response) |
| `403`  | `ACCOUNT_DISABLED`    | The account's only membership is a deactivated staff member |
| `429`  | `RATE_LIMITED`        | Too many requests                                  |

Uniform error body shape (see `docs/api-contracts/README.md`).
