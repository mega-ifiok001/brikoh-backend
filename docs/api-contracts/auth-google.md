# POST /api/public/auth/google

Route group: public
Auth: none
Rate-limited: yes

Signs an account in with a Google authorization code. This is the
server-side half of the "Sign in with Google" button: the frontend
redirects the browser to Google's consent screen, Google redirects back
to the frontend's callback route with a `code`, and the frontend POSTs
that code here. The backend exchanges it with Google using the
`GOOGLE_CLIENT_SECRET` (kept server-side, never in the browser) and
issues the same token pair as `/auth/login`.

Identity is resolved as follows:

- The account is looked up by the Google subject id (`googleSub`), then
  by the verified email.
- **Found** — the account is signed in. If it was created with a
  password (or an invite), the Google subject id is linked to it, so
  subsequent sign-ins match instantly.
- **Not found** — a new account is created from the Google profile
  (first/last name, email). It needs no password and its email is
  considered verified (Google verified it), so it goes straight to
  onboarding (`needsOnboarding: true`, `verified: true`).

## Google Cloud Console configuration

The OAuth client must be a "Web application" with these exact values:

- **Authorized JavaScript origins**: every frontend origin that shows
  the button — the production origin (`https://brikoh.com`) and each
  preview/staging origin (e.g. `https://<id>.arena.site`).
- **Authorized redirect URIs**: the same origins with
  `/auth/google/callback` appended — e.g. `https://brikoh.com/auth/google/callback`.

The backend validates the `redirectUri` sent in the body against the
same set (derived from `FRONTEND_URL` + `CORS_EXTRA_ORIGINS`), so an
unlisted origin cannot be used to complete an exchange. Any
`http://localhost` or `http://127.0.0.1` callback is auto-accepted for
local development (the developer adds their own callback to Google Cloud
Console).

## Request

Headers:

- `Content-Type: application/json`

Body:

```json
{
  "code": "string — the authorization code from Google's redirect query string",
  "redirectUri": "string — the exact redirect URI the browser was sent to"
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
    "verified": "boolean — true for Google-authenticated accounts"
  }
}
```

- The user shape is identical to `/auth/login` and `/auth/register`.
  A brand-new Google account has `needsOnboarding: true`; the frontend
  should route it to the onboarding flow.
- A newly created Google account has no password — password login for it
  returns `401 INVALID_CREDENTIALS`. Set a password via
  `/api/dashboard/settings/password` if password login is later desired.
- The frontend callback route stores the returned tokens and routes to
  `/onboarding` when `needsOnboarding` is `true`, otherwise to the
  dashboard.

## Error responses

| Status | Code                 | Condition                                                                                       |
| ------ | -------------------- | ----------------------------------------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`   | Missing `code`/`redirectUri`, unlisted `redirectUri`, or Google did not return a verified email |
| `401`  | `GOOGLE_AUTH_FAILED` | Google rejected the code (invalid, expired, or already exchanged)                               |
| `403`  | `ACCOUNT_DISABLED`   | The account's only membership is a deactivated staff member                                     |
| `429`  | `RATE_LIMITED`       | Too many requests                                                                               |

Uniform error body shape (see `docs/api-contracts/README.md`).
