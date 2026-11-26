# Password reset API

## Request a reset link

`POST /api/public/auth/forgot-password`

Request body:

```json
{ "email": "owner@example.com" }
```

For any valid email address, respond with HTTP `202` and the same message, whether or not the account exists:

```json
{
  "message": "If an account exists for that email, password reset instructions will be sent."
}
```

If the address belongs to an account and is not in the per-account cooldown, send a password-reset link. The link expires after one hour. Requests are rate-limited by client IP and by account cooldown.

## Complete a reset

`POST /api/public/auth/reset-password`

Request body:

```json
{
  "token": "rst_<opaque-token>",
  "newPassword": "new-password-123",
  "confirmPassword": "new-password-123"
}
```

On success, respond with HTTP `200`:

```json
{ "ok": true, "message": "Your password has been reset. Please sign in." }
```

An invalid, expired, or previously used token returns HTTP `400` with code `PASSWORD_RESET_INVALID`. On success, consume the token, invalidate all other reset links for that account, and revoke all refresh sessions in the same database transaction. The user must sign in again.

## Security behavior

- Reset tokens contain 256 bits of cryptographically secure randomness.
- Only a SHA-256 digest of the token is stored in PostgreSQL.
- Token consumption uses a conditional database update, so concurrent submissions cannot both reset the password.
- Password validation matches account registration: at least eight characters, with at least one letter and one digit.
- Reset request responses do not disclose whether an account exists.
