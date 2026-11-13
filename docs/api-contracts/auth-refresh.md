# POST /api/public/auth/refresh

Route group: public
Auth: none
Rate-limited: yes

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

## Error responses

| Status | Code                   | Condition                                                        |
| ------ | ---------------------- | ---------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`     | Missing or malformed `refreshToken` body                         |
| `401`  | `INVALID_REFRESH_TOKEN`| Unknown, expired, or already-revoked token (normal single use)   |
| `401`  | `TOKEN_REUSE_DETECTED` | A revoked token was presented again — possible theft; all active refresh tokens for the account are revoked, the client must re-authenticate |
| `429`  | `RATE_LIMITED`         | Too many requests                                                |

Clients treat every `401` here as "go to login" — `TOKEN_REUSE_DETECTED`
is documented for server-side auditing, not for distinct client UX.

Uniform error body shape (see `docs/api-contracts/README.md`).
