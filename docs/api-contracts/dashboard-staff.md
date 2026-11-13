# Staff management (dashboard)

Route group: dashboard
Auth: bearer + store, **owner-only** (`requireOwner`)
Rate-limited: no

Manages the store's active staff members: listing, role/permission updates,
and removal. Every endpoint in this file is owner-only — a staff member is
rejected with `403 INSUFFICIENT_PERMISSIONS` even when their account holds
the `staff.manage` permission flag (staff management is a tenant-root
privilege; the flag is reserved for a future finer-grained scheme).

The tenant comes from `req.tenant.storeId`, never from the client.

## GET /api/dashboard/staff

Lists every `StaffMember` row for the store (active or deactivated),
oldest first.

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
      "id": "string — staff member id",
      "email": "string — the account's email",
      "role": "ADMIN | MANAGER | STAFF",
      "permissions": ["string — permission flags"],
      "isActive": true,
      "createdAt": "string — UTC ISO-8601"
    }
  ]
}
```

`permissions` may contain the wildcard `"all"` — the staff member
effectively holds every permission flag. It is stored verbatim and
expanded to the full set at request time (see `authorize`).

Pending invites are NOT included here — see
[dashboard-staff-invites.md](dashboard-staff-invites.md).

## Error responses

| Status | Code                  | Condition                                      |
| ------ | --------------------- | ---------------------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing/invalid token, or no store association |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated as a staff member (any role, any permissions) |

---

## PATCH /api/dashboard/staff/:staffId

Updates the staff member's role and/or permission flags. Both fields are
optional but at least one must be present. Permissions are validated against
the known allowlist (`products.manage`, `orders.manage`, `customers.manage`,
`invoices.manage`, `staff.manage`, `locations.manage`, `catalog.manage`,
`analytics.manage`, `viewProfit`).

## Request

Path params:
- `staffId: string`

Body (at least one field required):

```json
{
  "role": "ADMIN | MANAGER | STAFF",
  "permissions": ["string — allowlisted permission flags or "all""],
  "isActive": true
}
```

`isActive: false` deactivates the member: every refresh token of their
account is revoked immediately (their existing access tokens die with
their short lifetime) and the member can no longer sign in (`403
ACCOUNT_DISABLED`). Re-activating restores login; `role`/`permissions`
are untouched by a deactivation.

## Success response

Status: `200`

```json
{
  "id": "string",
  "email": "string",
  "role": "ADMIN | MANAGER | STAFF",
  "permissions": ["string"],
  "isActive": true,
  "updatedAt": "string — UTC ISO-8601"
}
```

## Error responses

| Status | Code                  | Condition                                      |
| ------ | --------------------- | ---------------------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Unknown permission flag, no fields supplied, malformed body |
| `401`  | `UNAUTHORIZED`        | Missing/invalid token, or no store association |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated as a staff member          |
| `404`  | `NOT_FOUND`           | Staff member not found in this store          |

---

## DELETE /api/dashboard/staff/:staffId

Removes the staff member from the store: the `StaffMember` row is deleted
and every active refresh token of their account is revoked, so the removed
member loses access immediately (access tokens expire within their normal
lifetime; a removed member can no longer refresh a session).

The account itself is not deleted. Ledger attribution keeps working: ledger
entries record `performedByStaffId` as `null` after removal (onDelete
SetNull).

## Success response

Status: `204` — no body.

## Error responses

| Status | Code                  | Condition                                      |
| ------ | --------------------- | ---------------------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing/invalid token, or no store association |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated as a staff member          |
| `404`  | `NOT_FOUND`           | Staff member not found in this store          |

Uniform error body shape (see `docs/api-contracts/README.md`).
