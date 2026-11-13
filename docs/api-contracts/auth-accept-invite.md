# POST /api/public/auth/accept-invite

Route group: public (auth group, rate-limited)
Auth: none (the invite token is the credential)
Rate-limited: yes

Completes a staff invite: given a valid, unexpired, unused invite token and
a new password, it creates the `Account` and `StaffMember` rows **in one
transaction**, marks the `InviteToken` `ACCEPTED`, and logs the invitee in
immediately (response mirrors `POST /auth/register`).

Single-use invariant: a token that has already been accepted is rejected
even when its row still exists. The acceptance is a conditional update
(`WHERE status = PENDING`), so two concurrent requests presenting the same
token race safely — exactly one succeeds.

Permission flags are NOT accepted with the token; they are derived from the
invite's role at acceptance:

| Role    | Default permissions                                                       |
| ------- | ------------------------------------------------------------------------- |
| ADMIN   | `products.manage`, `orders.manage`, `customers.manage`, `invoices.manage` |
| MANAGER | `products.manage`, `orders.manage`                                        |
| STAFF   | `orders.manage`                                                           |

The owner can adjust flags afterward via
`PATCH /api/dashboard/staff/:staffId`.

## Request

Body:

```json
{
  "token": "string — the token from the invite email (inv_...)",
  "password": "string — >= 8 chars, at least one letter and one digit"
}
```

## Success response

Status: `201`

```json
{
  "accessToken": "string",
  "refreshToken": "string",
  "user": {
    "accountId": "string",
    "email": "string",
    "role": "ADMIN | MANAGER | STAFF",
    "storeId": "string",
    "storeName": "string",
    "subdomain": "string | null — the store's storefront subdomain; set for every new store (auto-generated at onboarding); null only for stores created before auto-generation"
  }
}
```

## Error responses

| Status | Code               | Condition                                                                                        |
| ------ | ------------------ | ------------------------------------------------------------------------------------------------ |
| `400`  | `VALIDATION_ERROR` | Malformed body (bad password shape)                                                              |
| `400`  | `INVITE_INVALID`   | Token is unknown, already accepted, or the invite's email already belongs to an existing account |
| `400`  | `INVITE_EXPIRED`   | Token is still `PENDING` but past `expiresAt`                                                    |

All four conditions produce the same HTTP-400 class so clients show one
"broken or expired invite — ask the owner to resend" state, with the code
distinguishing expired (resend will fix it) from invalid (resend won't).

Uniform error body shape (see `docs/api-contracts/README.md`).

 ## GET /api/public/auth/accept-invite/:token

Route group: public (auth group, rate-limited)
Auth: none (the invite token is the credential)
Rate-limited: yes

Read-only preview of a pending invite, for the frontend `/invite` page to
render context (store name, role, inviter) and validate the link before the
invitee sets a password. It shares the accept endpoint's error codes so the
client shows one "broken or expired — ask owner to resend" state.

The inviter email is the store owner's account email — invites are owner-only,
so the inviting account is always the store's owner (no separate column is
stored on `InviteToken`).

### Path params

- `token` — the invite token from the email link (`inv_…`).

### Success response

Status: `200`

```json
{
  "email": "string — invitee email",
  "storeName": "string",
  "role": "ADMIN | MANAGER | STAFF",
  "inviterEmail": "string — the store owner who sent the invite",
  "expiresAt": "ISO-8601 timestamp"
}
```

### Error responses

| Status | Code             | Condition                                     |
| ------ | ---------------- | --------------------------------------------- |
| `400`  | `INVITE_INVALID` | Token is unknown or already accepted/used     |
| `400`  | `INVITE_EXPIRED` | Token is still `PENDING` but past `expiresAt` |
