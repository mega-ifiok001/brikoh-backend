# POST /api/public/auth/logout

Route group: public
Auth: none
Rate-limited: yes

Revokes the presented refresh token server-side. Idempotent: logging out
twice, or with an already-revoked or expired token, still succeeds — the
client always ends up signed out.

## Request

Headers:
- `Content-Type: application/json`

Body:

```json
{
  "refreshToken": "string — opaque token to revoke"
}
```

## Success response

Status: `204` — no body.

The access token keeps its own short lifetime; it is not revoked by this
endpoint. Clients should discard it on logout.

## Error responses

| Status | Code               | Condition                          |
| ------ | ------------------ | ---------------------------------- |
| `400`  | `VALIDATION_ERROR` | Missing or malformed `refreshToken` |
| `429`  | `RATE_LIMITED`     | Too many requests                  |

Uniform error body shape (see `docs/api-contracts/README.md`).
