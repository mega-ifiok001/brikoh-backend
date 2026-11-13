# Staff invites (dashboard)

Route group: dashboard
Auth: bearer + store, **owner-only** (`requireOwner`)
Rate-limited: no

Owner-only invite lifecycle for new staff members. Inviting a person creates
an `InviteToken` row ONLY — no `Account` and no `StaffMember` row exists
until the invitee accepts via the public accept-invite endpoint
([auth-accept-invite.md](auth-accept-invite.md)).

The tenant comes from `req.tenant.storeId`, never from the client.

**The invite token is a secret.** It is never returned by any endpoint here —
it is delivered only inside the invite email (and logged by the development
email stub). Revocation works by invite id, which the owner obtains from the
list response.

## GET /api/dashboard/staff/invites

Lists the store's pending (revocable) invites, oldest first. Accepted and
expired invites are not returned.

## Request

Headers:
- `Authorization: Bearer <accessToken>`

No query params, no path params, no body.

## Success response

Status: `200`

```json
{
  "items": [
    {
      "id": "string — invite id",
      "email": "string",
      "role": "ADMIN | MANAGER | STAFF",
      "status": "PENDING",
      "expiresAt": "string — UTC ISO-8601",
      "createdAt": "string — UTC ISO-8601"
    }
  ]
}
```

## Error responses

| Status | Code                  | Condition                                      |
| ------ | --------------------- | ---------------------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing/invalid token, or no store association |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated as a staff member (any role, any permissions) |

---

## POST /api/dashboard/staff/invites

Invites a new staff member. Validates the store's `Subscription.staffCap`
BEFORE the `InviteToken` is created: inviting at or beyond the cap fails
with `409 STAFF_LIMIT_REACHED` and nothing is persisted.

Cap semantics: the cap counts **active `StaffMember` rows only**. Pending
invites do not consume capacity (an invite that is never accepted expires
after 7 days without blocking future invites). A store with no subscription
or a `staffCap` of `null` has no limit.

The check and the insert run in one transaction, and the transaction takes
a `FOR UPDATE` lock on the store row so two concurrent invites at the cap
cannot both slip through (exactly one wins).

Inviting an email that already has a pending invite issues a fresh token and
marks the previous pending invite `EXPIRED` (the old token stops working —
this lets a re-invite carry a different role).

The invite email (store name, inviter, accept link, expiry date) is sent
after the row is created. Email delivery failure does NOT fail the invite:
the `InviteToken` row exists and the failure is logged server-side.

## Request

Headers:
- `Authorization: Bearer <accessToken>`

Body:

```json
{
  "email": "string — email address, lowercased",
  "role": "ADMIN | MANAGER | STAFF"
}
```

The invitee's permission flags are not part of the invite: on acceptance
they are derived from the role (see auth-accept-invite.md).

## Success response

Status: `201`

```json
{
  "id": "string — invite id",
  "email": "string",
  "role": "ADMIN | MANAGER | STAFF",
  "status": "PENDING",
  "expiresAt": "string — UTC ISO-8601",
  "expiresInSeconds": "number"
}
```

## Error responses

| Status | Code                  | Condition                                      |
| ------ | --------------------- | ---------------------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Malformed body, unknown role                   |
| `401`  | `UNAUTHORIZED`        | Missing/invalid token, or no store association |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated as a staff member          |
| `409`  | `EMAIL_TAKEN`         | The email already belongs to an existing account (an account is a single-identity record and cannot be re-invited) |
| `409`  | `ALREADY_STAFF`       | The email already belongs to an active staff member of this store |
| `409`  | `STAFF_LIMIT_REACHED` | Active staff count is at the subscription's `staffCap`; nothing is persisted |

---

## DELETE /api/dashboard/staff/invites/:inviteId

Revokes a pending invite. The `InviteToken` row is deleted, so the invite
link immediately stops working.

## Request

Path params:
- `inviteId: string`

No body.

## Success response

Status: `204` — no body.

## Error responses

| Status | Code                  | Condition                                      |
| ------ | --------------------- | ---------------------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing/invalid token, or no store association |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated as a staff member          |
| `404`  | `NOT_FOUND`           | No pending invite with that id in this store  |

Uniform error body shape (see `docs/api-contracts/README.md`).
