# Mobile PIN authentication

Initial sign-in uses the existing email/password or Google account flow. After that authenticated sign-in, the mobile client can enroll an account PIN. The account PIN is exactly six digits and is stored as a bcrypt hash. Do not store it on-device or send it over any endpoint except TLS.

## `POST /api/public/auth/pin-login`

Request:

```json
{ "email": "merchant@example.com", "pin": "042781" }
```

Returns the normal auth session (`accessToken`, `refreshToken`, `user`) on success. The endpoint returns the same `INVALID_CREDENTIALS` response for an unknown email, an unconfigured PIN, or an incorrect PIN. Five consecutive incorrect PIN attempts lock PIN sign-in for 15 minutes; the account password remains available for recovery. The endpoint is rate-limited.

## `GET /api/dashboard/settings/pin`

Requires bearer authentication. Returns `{ "configured": boolean }` without revealing the PIN hash or lock state.

## `PUT /api/dashboard/settings/pin`

Requires bearer authentication. Configure an initial PIN after signing in with account credentials:

```json
{ "pin": "042781" }
```

Changing an existing PIN also requires the account password:

```json
{ "pin": "123456", "currentPassword": "account-password" }
```

Returns `{ "ok": true }`. Use the existing password reset flow if the account password is unavailable, then sign in with that password and change the PIN. Google-only accounts can initially set a PIN; a password-based reauthentication mechanism must be added before allowing them to replace it.

## Trusted-device quick sign-in

Biometrics are verified locally through the operating system prompt; Brikoh does not receive or store biometric data. A four-digit returning-device PIN is a distinct, device-local unlock method and must not be submitted to `pin-login` (which accepts only the six-digit account PIN). Store the local verifier in OS-protected storage, apply local attempt limits, and return to account credentials for recovery.
