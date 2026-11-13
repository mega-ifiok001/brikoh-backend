# Catalog taxonomy — categories + units — dashboard group

Routes:
- `POST /api/dashboard/categories` — create
- `GET /api/dashboard/categories` — list
- `GET /api/dashboard/categories/:categoryId` — get by id
- `PATCH /api/dashboard/categories/:categoryId` — update
- `DELETE /api/dashboard/categories/:categoryId` — delete
- `POST /api/dashboard/units` — create
- `GET /api/dashboard/units` — list
- `GET /api/dashboard/units/:unitId` — get by id
- `PATCH /api/dashboard/units/:unitId` — update
- `DELETE /api/dashboard/units/:unitId` — delete

Route group: dashboard
Auth: bearer + store
Rate-limited: no

Categories and units are the store's catalog taxonomy. Products reference
them via `categoryId` / `unitId` (set at create or update). The tenant
always comes from `req.tenant.storeId` — a client-supplied storeId is never
accepted, and a category/unit of another store is indistinguishable from a
missing one (`404 NOT_FOUND`).

Permissions: all routes require the `catalog.manage` permission (owners
pass implicitly).

## Category shape

```json
{
  "id": "string — uuid (v7)",
  "storeId": "string — uuid (v7)",
  "name": "string — 1-120 chars",
  "description": "string | null — up to 1000 chars",
  "createdAt": "string — UTC ISO-8601",
  "updatedAt": "string — UTC ISO-8601"
}
```

## Unit shape

```json
{
  "id": "string — uuid (v7)",
  "storeId": "string — uuid (v7)",
  "name": "string — 1-120 chars",
  "symbol": "string | null — up to 16 chars, e.g. \"kg\", \"pc\"",
  "createdAt": "string — UTC ISO-8601",
  "updatedAt": "string — UTC ISO-8601"
}
```

## POST /api/dashboard/categories

Body:

```json
{
  "name": "string — required, trimmed, 1-120 chars",
  "description": "string | null — optional, up to 1000 chars"
}
```

Success: `201` — Category shape.

## GET /api/dashboard/categories

Returns the tenant's categories, oldest first.

Success: `200`

```json
{
  "items": ["Category shape"]
}
```

## GET /api/dashboard/categories/:categoryId

Success: `200` — Category shape.
`404 NOT_FOUND` for unknown or cross-tenant ids.

## PATCH /api/dashboard/categories/:categoryId

Body: any subset of `name`, `description` (same rules as create).

Success: `200` — Category shape.
`404 NOT_FOUND` for unknown / cross-tenant ids.

## DELETE /api/dashboard/categories/:categoryId

Hard-deletes the category. Attached products keep existing —
`Product.categoryId` is SetNull, so they simply become uncategorized.

Success: `204`.
`404 NOT_FOUND` for unknown / cross-tenant ids.

## Units (identical semantics to categories)

- `POST /api/dashboard/units` — body `{ "name": required, "symbol": string | null optional }` → `201` Unit shape
- `GET /api/dashboard/units` → `200` `{ "items": ["Unit shape"] }`
- `GET /api/dashboard/units/:unitId` → `200` Unit shape
- `PATCH /api/dashboard/units/:unitId` — any subset of `name`, `symbol` → `200` Unit shape
- `DELETE /api/dashboard/units/:unitId` — hard delete; products become unit-less (SetNull) → `204`

## Error responses

| Status | Code                  | Condition                                    |
| ------ | --------------------- | -------------------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Malformed body                               |
| `401`  | `UNAUTHORIZED`        | Missing/invalid token, or no store association |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Lacks `catalog.manage`                |
| `404`  | `NOT_FOUND`           | Unknown or cross-tenant id                   |
| `409`  | `CATEGORY_EXISTS`     | Another category of the store has the same name |
| `409`  | `UNIT_EXISTS`         | Another unit of the store has the same name  |

Uniform error body shape (see `docs/api-contracts/README.md`).
