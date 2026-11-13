# Branches CRUD + stock transfers — dashboard group

Routes:
- `POST /api/dashboard/branches` — create
- `GET /api/dashboard/branches` — list
- `GET /api/dashboard/branches/:branchId` — get by id
- `PATCH /api/dashboard/branches/:branchId` — update
- `PUT /api/dashboard/branches/:branchId/default` — make default
- `DELETE /api/dashboard/branches/:branchId` — delete
- `POST /api/dashboard/branches/transfers` — transfer stock between branches

Route group: dashboard
Auth: bearer + store
Rate-limited: no

Every store is created with one **Main Branch** (at onboarding), which is
also its default branch (`Store.defaultBranchId`). The default branch is
the branch public checkout and staff sales resolve against, and the branch
new products are stocked on. The tenant always comes from
`req.tenant.storeId` — a client-supplied storeId is never accepted.

Permissions:
- Branch CRUD + default management: `locations.manage`
- Stock transfers: `products.manage` (stock movement carries the same trust
  as stock-adjustments). The transfer router is mounted BEFORE the CRUD
  router so `/transfers` can never be swallowed as a `:branchId`.

## Branch shape

```json
{
  "id": "string — uuid (v7)",
  "storeId": "string — uuid (v7)",
  "name": "string — 1-120 chars",
  "address": "string | null — up to 500 chars",
  "isDefault": "boolean — true exactly for Store.defaultBranchId",
  "createdAt": "string — UTC ISO-8601",
  "updatedAt": "string — UTC ISO-8601"
}
```

## POST /api/dashboard/branches

Body:

```json
{
  "name": "string — required, trimmed, 1-120 chars",
  "address": "string | null — optional, up to 500 chars"
}
```

A new branch starts with **no stock anywhere** — existing products live on
the branches they were created/transferred to; the first transfer into a
branch creates its `BranchStock` rows.

Success: `201` — Branch shape.

## GET /api/dashboard/branches

Returns the tenant's branches, oldest first, with `isDefault` flagged.

Success: `200`

```json
{
  "items": ["Branch shape"]
}
```

## GET /api/dashboard/branches/:branchId

Success: `200` — Branch shape.
`404 BRANCH_NOT_FOUND` for unknown or cross-tenant ids.

## PATCH /api/dashboard/branches/:branchId

Body: any subset of `name`, `address` (same rules as create); at least one
field is required.

Success: `200` — Branch shape.
`404 BRANCH_NOT_FOUND` for unknown / cross-tenant ids.

## PUT /api/dashboard/branches/:branchId/default

Makes the branch the store's default branch (the branch checkout and staff
sales resolve against). No body.

Success: `200` — Branch shape (now with `isDefault: true`).
`404 BRANCH_NOT_FOUND` for unknown / cross-tenant ids.

## DELETE /api/dashboard/branches/:branchId

Deletes the branch. Service-gated:

- the **default branch** can never be deleted — transfer its stock away and
  make another branch default first (`409 DEFAULT_BRANCH`);
- a branch **holding stock** must be emptied first
  (`409 BRANCH_HAS_STOCK`);
- a branch **with order history** cannot be deleted — financial records
  must keep their branch attribution (`409 BRANCH_HAS_ORDERS`, enforced by
  the DB Restrict foreign key).

Ledger history keeps its rows: `StockLedgerEntry.branchId` is SetNull, so
the branch's movements become anonymous history (same pattern as staff
removal).

Success: `200`

```json
{
  "id": "string — the deleted branch id"
}
```

`404 BRANCH_NOT_FOUND` for unknown / cross-tenant ids.

## POST /api/dashboard/branches/transfers

Moves stock from one branch to another. One transaction writes both ledger
legs — `TRANSFER_OUT` on the source (guarded decrement: source stock can
never go negative) and `TRANSFER_IN` on the destination (row auto-created
if the destination never held this product before).

Body:

```json
{
  "productId": "string — required",
  "variantId": "string — optional; REQUIRED when the product has variants",
  "sourceBranchId": "string — required",
  "destinationBranchId": "string — required",
  "quantity": "number — integer, required, 1-999999"
}
```

Success: `200`

```json
{
  "productId": "string",
  "variantId": "string | null",
  "quantity": "number — the transferred quantity",
  "sourceBranch": {
    "branchId": "string",
    "quantityChange": "number — always -quantity",
    "stockAfter": "number — resulting source stock, >= 0"
  },
  "destinationBranch": {
    "branchId": "string",
    "quantityChange": "number — always +quantity",
    "stockAfter": "number — resulting destination stock"
  }
}
```

## Error responses

| Status | Code                       | Condition                                              |
| ------ | -------------------------- | ------------------------------------------------------ |
| `400`  | `VALIDATION_ERROR`         | Malformed body (e.g. empty transfer quantity, unknown body keys) |
| `400`  | `VARIANT_REQUIRED`         | Transfer of a variant product without `variantId`      |
| `400`  | `TRANSFER_SAME_BRANCH`     | Source and destination branch are the same             |
| `401`  | `UNAUTHORIZED`             | Missing/invalid token, or no store association         |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Lacks the route's required permission                  |
| `404`  | `BRANCH_NOT_FOUND`         | Unknown or cross-tenant branch                         |
| `404`  | `NOT_FOUND`                | Unknown, cross-tenant, or soft-deleted product         |
| `404`  | `VARIANT_NOT_FOUND`        | Variant belongs to another product or store            |
| `409`  | `BRANCH_EXISTS`            | Another branch of the store has the same name          |
| `409`  | `DEFAULT_BRANCH`           | Deleting the store's default branch                    |
| `409`  | `BRANCH_HAS_STOCK`         | Deleting a branch that still holds stock               |
| `409`  | `BRANCH_HAS_ORDERS`        | Deleting a branch with order history                   |
| `409`  | `INSUFFICIENT_STOCK`       | Source branch lacks the quantity; nothing is persisted |

Uniform error body shape (see `docs/api-contracts/README.md`).
