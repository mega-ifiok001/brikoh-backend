# GET /api/dashboard/me

Route group: dashboard
Auth: bearer (authenticate only — tenant resolution happens inside the
handler, not via the `resolveTenant` middleware, so that an account that
has registered but not onboarded receives a `needsOnboarding` response
instead of a 401)
Rate-limited: no

Returns the authenticated account's identity and its tenant context when
it has one. This is the canonical "who am I" endpoint for the dashboard:
the frontend uses it to decide between the verification screen
(`verified: false`), the onboarding flow (`needsOnboarding: true`), and
the tenant dashboard.

## Request

Headers:
- `Authorization: Bearer <accessToken>`

No query params, no path params, no body.

## Success response

Status: `200`

```json
{
  "accountId": "string",
  "email": "string",
  "firstName": "string | null",
  "lastName": "string | null",
  "phone": "string | null",
  "role": "OWNER | ADMIN | MANAGER | STAFF | null",
  "storeId": "string | null",
  "storeName": "string | null",
  "subdomain": "string | null",
  "permissions": ["string"],
  "needsOnboarding": "boolean",
  "verified": "boolean"
}
```

- `permissions`: the staff member's permission flags; owners receive the
  full permission set; an account that has not onboarded receives `[]`.
- Before onboarding, `role` and the tenant fields are `null` and
  `needsOnboarding` is `true`.
- `verified` is `true` once the email was verified (`POST
  /api/public/auth/verify`). Only meaningful before onboarding —
  onboarding itself is blocked until the email is verified.

## Error responses

| Status | Code                  | Condition                                                     |
| ------ | --------------------- | ------------------------------------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token — no client-visible distinction between invalid and expired |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Reserved for future permission-gated routes; `/me` itself is open to any authenticated account |

Uniform error body shape (see `docs/api-contracts/README.md`).
