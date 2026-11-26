# POST /api/public/auth/refresh

Route group: public
Auth: none
Rate-limited: yes (10 requests per client IP per minute; the public auth
group also applies its general 300 requests per minute limit)

Exchanges a valid refresh token for a new token pair. The presented token
is revoked and a new one issued in the same response (rotation). A refresh
token can only be used successfully once.

## Request

Headers:
- `Content-Type: application/json`

Body:

```json
{
  "refreshToken": "string — opaque token previously issued by register/login/refresh"
}
```

## Success response

Status: `200`

```json
{
  "accessToken": "string — JWT, 15-minute lifetime",
  "refreshToken": "string — new opaque single-use token"
}
```

The new refresh token extends the session by another 7 days from the time
of refresh (sliding lifetime). The presented token is revoked server-side
and must never be used again.

## Mobile client behavior

- Persist the refresh token in OS-protected secure storage. Never log it or
  place it in a URL. Keep the access token in memory where practical.
- Read the access token's JWT `exp` claim and renew shortly before expiry
  (for example, 60 seconds early). On app resume after idle, check expiry
  and refresh before resuming API work. Do not wait for a user action to
  discover expiry.
- Allow only one refresh request at a time per stored session. A successful
  response replaces **both** stored tokens atomically; the old refresh token
  is single-use. If a request gets `401 SESSION_EXPIRED`, refresh and retry
  the original request once. Do not retry it repeatedly.
- If refresh returns `401`, preserve unsent local work, clear the session
  credentials, and ask the user to sign in again. `429` includes
  `Retry-After`; back off instead of retrying immediately.

## Error responses

| Status | Code                   | Condition                                                        |
| ------ | ---------------------- | ---------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`     | Missing or malformed `refreshToken` body                         |
| `401`  | `INVALID_REFRESH_TOKEN`| Unknown or malformed token                                      |
| `401`  | `SESSION_EXPIRED`      | Refresh session expired; sign in again                          |
| `401`  | `TOKEN_REUSE_DETECTED` | A revoked token was presented again — possible theft; all active refresh tokens for the account are revoked, the client must re-authenticate |
| `429`  | `RATE_LIMITED`         | Too many requests                                                |

Clients treat every `401` here as "go to login" — `TOKEN_REUSE_DETECTED`
is documented for server-side auditing, not for distinct client UX.

Uniform error body shape (see `docs/api-contracts/README.md`).
