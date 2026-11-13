# POST /api/dashboard/resend-verification

Route group: dashboard
Auth: bearer (authenticate only — same account-level trust as
`GET /api/dashboard/me`; the route needs no tenant, so `resolveTenant`
is deliberately NOT mounted)
Rate-limited: yes

Issues a fresh verification token and re-sends the verification email for
the authenticated account. The previous pending token is invalidated —
only one pending token per account exists at a time. Sends are rate
limited: requesting a resend within 60 seconds of the last issuance is
rejected.

## Request

Headers:
- `Authorization: Bearer <accessToken>`

No body.

## Success response

Status: `200`

```json
{
  "sent": true
}
```

## Error responses

| Status | Code                  | Condition                                       |
| ------ | --------------------- | ----------------------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token            |
| `404`  | `NOT_FOUND`           | Account no longer exists                        |
| `409`  | `ALREADY_VERIFIED`    | The account's email is already verified         |
| `429`  | `RATE_LIMITED`        | Too many requests — resends are limited to one per 60 seconds |
| `429`  | `RATE_LIMITED`        | Group rate limit exceeded                       |

Uniform error body shape (see `docs/api-contracts/README.md`).
