# GET /api/dashboard/activity

Route group: dashboard
Auth: bearer + store
Rate-limited: no

Reads the store's activity log: an append-only, per-store trail of who did
what to which resource. The owner is the only role allowed to read it — the
log can expose sensitive cross-staff information, so staff tokens are
rejected with `403` regardless of permissions.

Rows are written automatically by the server (products, stock movements,
staff changes). They are immutable at the database level (an append-only
trigger rejects any UPDATE/DELETE), so this endpoint is strictly read-only
by construction.

## Request

Query params:
- `limit: number — optional, default 50, min 1, max 200`
- `cursor: string (activity entry id) — optional; the first entry after the cursor`
- `staffMemberId: string — optional; only entries attributed to this staff member`
- `start: string — optional, UTC ISO-8601 datetime; only entries at or after this instant`
- `end: string — optional, UTC ISO-8601 datetime; only entries strictly before this instant (send end-of-day as the next day's midnight)`

## Success response

Status: `200`

```json
{
  "items": [
    {
      "id": "string — uuid (v7)",
      "staffMemberId": "string | null — the acting staff member; null for owners and webhook-driven entries",
      "action": "string — dotted, e.g. \"product.created\"",
      "detail": "object — action-specific context",
      "createdAt": "string — UTC ISO-8601"
    }
  ],
  "nextCursor": "string | null — present only when more entries follow the returned page",
  "total": "number — count of all entries matching the filters"
}
```

Entries are ordered by `createdAt DESC, id DESC` (stable under inserts).

## Actions

| Action                 | detail                                            |
| ---------------------- | ------------------------------------------------- |
| `product.created`      | productId, name, variantCount                     |
| `product.updated`      | productId, name, updatedFields                    |
| `product.deleted`      | productId                                         |
| `product.published`    | productId, name                                   |
| `product.unpublished`  | productId, name                                   |
| `bulk.imported`        | importId, created, overwritten, skipped, failed   |
| `stock.adjusted`       | productId, productName, branchId, branchName, variantId (null), variantName (null), quantityChange, reason |
| `stock.sale`           | same as stock.adjusted (webhook-driven, staffMemberId always null) |
| `stock.transferred`    | productId, variantId (null), sourceBranchId, destinationBranchId, quantity |
| `branch.created`       | branchId, name                                    |
| `branch.updated`       | branchId, previousName                            |
| `branch.default_changed` | branchId                                         |
| `branch.deleted`       | branchId                                          |
| `catalog.category.created` | categoryId, name                              |
| `catalog.category.updated` | categoryId, updatedFields                     |
| `catalog.category.deleted` | categoryId                                    |
| `catalog.unit.created` | unitId, name                                      |
| `catalog.unit.updated` | unitId, updatedFields                             |
| `catalog.unit.deleted` | unitId                                            |
| `staff.joined`         | staffMemberId, email, role                        |
| `staff.role.updated`   | staffMemberId, email, from, to                    |
| `staff.removed`        | staffMemberId, email                              |

## Error responses

| Status | Code               | Condition                                        |
| ------ | ------------------ | ------------------------------------------------ |
| `400`  | `VALIDATION_ERROR` | Invalid limit/cursor/dates (cursor must exist; ISO datetimes must carry an offset) |
| `401`  | `UNAUTHORIZED`     | Missing/invalid token, or no store association   |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Authenticated but not the store owner     |

Uniform error body shape (see `docs/api-contracts/README.md`).
