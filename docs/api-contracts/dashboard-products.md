# Products CRUD — dashboard group

Routes:
- `POST /api/dashboard/products` — create
- `GET /api/dashboard/products` — list (cursor-paginated)
- `GET /api/dashboard/products/:productId` — get by id
- `PATCH /api/dashboard/products/:productId` — update
- `DELETE /api/dashboard/products/:productId` — soft delete
- `POST /api/dashboard/products/:productId/publish` — publish
- `POST /api/dashboard/products/:productId/unpublish` — unpublish
- `PUT /api/dashboard/products/:productId/options` — define option dimensions + regenerate the variant grid
- `POST /api/dashboard/products/:productId/variants` — add one variant
- `PATCH /api/dashboard/products/:productId/variants/:variantId` — update a variant (name/price/SKU)
- `POST /api/dashboard/products/:productId/variants/:variantId/archive` — retire a variant
- `POST /api/dashboard/products/:productId/variants/:variantId/restore` — un-retire a variant
- `POST /api/dashboard/products/bulk/import` — bulk import preview (no writes)
- `POST /api/dashboard/products/bulk/confirm` — bulk import confirm (writes)

Route group: dashboard
Auth: bearer + store
Rate-limited: no

Every route resolves the tenant from the authenticated request context
(`req.tenant.storeId`) — a client-supplied storeId is never accepted, and a
product belonging to another store is indistinguishable from a missing one
(`404 NOT_FOUND`). All routes require the `products.manage` permission.

## Product shape

```json
{
  "id": "string — uuid (v7)",
  "storeId": "string — uuid (v7)",
  "name": "string — 1-120 chars",
  "sku": "string | null — optional, up to 64 chars; the merchant's product-level SKU (variants carry their own sku)",
  "price": "string — decimal, stored with exactly 2dp but serialized without forced trailing zeros, e.g. \"19.99\" or \"8\" (JSON-safe string, never a float)",
  "costPrice": "string | null — decimal, same serialization rules as price; the merchant's cost basis, never shown at checkout",
  "shippingWeightKg": "string | null — product shipping weight in kilograms (up to 3 decimals); required for Shipbubble checkout",
  "description": "string | null — up to 2000 chars",
  "images": ["string — array of public image URLs, max 10"],
  "coverImageUrl": "string | null — the primary photo shown in listings and checkout",
  "discountPrice": "string | null — decimal; the promotional price shown instead of price when set (always lower than price)",
  "lowStockThreshold": "number | null — integer; LOW_STOCK alert trigger when cached stock drops to or below it (null = no alerts)",
  "expiryDate": "string | null — UTC ISO-8601; perishable-goods expiry (null = non-expiring)",
  "status": "\"DRAFT\" | \"PUBLISHED\" — products start DRAFT; publish is the explicit go-live step",
  "categoryId": "string | null — uuid; must belong to the store, or 404 at write time",
  "unitId": "string | null — uuid; must belong to the store, or 404 at write time",
  "category": "Category shape | null — full row, see dashboard-catalog.md",
  "unit": "Unit shape | null — full row, see dashboard-catalog.md",
  "quantity": "number — integer, always >= 0 (stock moves ONLY through the stock-adjustment endpoint; inert once the product has variants)",
  "deletedAt": "string | null — UTC ISO-8601; set by soft delete, null otherwise",
  "options": ["Option shape — the variant dimensions, see below"],
  "variants": ["Variant shape — see below"],
  "createdAt": "string — UTC ISO-8601",
  "updatedAt": "string — UTC ISO-8601"
}
```

## Option shape

A product-scoped variant dimension (max **2** per product), e.g. `Colour`
or `Size`. The merchant names it and supplies its values as free text — the
platform has no fixed colour/size list.

```json
{
  "id": "string — uuid (v7)",
  "name": "string — 1-40 chars, e.g. \"Colour\", \"Size\"",
  "values": [
    {
      "id": "string — uuid (v7)",
      "value": "string — 1-40 chars, e.g. \"Red\", \"M\"",
      "sortOrder": "number — integer, display order"
    }
  ],
  "sortOrder": "number — integer, display order of the dimension"
}
```

## Variant shape

```json
{
  "id": "string — uuid (v7)",
  "name": "string — 1-80 chars, e.g. \"M\" or \"Red / M\"; derived from the option values when not supplied",
  "sellingPrice": "string | null — optional decimal (same rules as price); falls back to the product price at checkout when null",
  "sku": "string | null — optional, up to 64 chars",
  "quantity": "number — integer, always >= 0 (per-variant stock, moved only through the stock-adjustment endpoint)",
  "options": [
    { "name": "string — the option (dimension) name", "value": "string — the value chosen for this variant" }
  ],
  "archivedAt": "string | null — UTC ISO-8601; set when the variant is retired (hidden from the storefront), null otherwise",
  "createdAt": "string — UTC ISO-8601",
  "updatedAt": "string — UTC ISO-8601"
}
```

## POST /api/dashboard/products

Body:

```json
{
  "name": "string — required, trimmed, 1-120 chars",
  "sku": "string | null — optional, trimmed, up to 64 chars; product-level SKU",
  "price": "number or string — required, > 0, at most 2 decimal places, max 99999999.99",
  "costPrice": "number or string — optional (null when absent), >= 0, at most 2 decimal places, max 99999999.99",
  "shippingWeightKg": "number or string | null — optional shipping weight in kg, 0.001..99999.999, at most 3 decimal places; required to request Shipbubble rates",
  "description": "string | null — optional, up to 2000 chars",
  "images": "string[] — optional, max 10 URLs",
  "coverImageUrl": "string | null — optional, valid URL, up to 2048 chars",
  "discountPrice": "number or string | null — optional; must be lower than price (409/400 otherwise)",
  "lowStockThreshold": "number — optional, integer >= 0",
  "expiryDate": "string — optional, UTC ISO-8601 date-time",
  "categoryId": "string | null — optional; the id of one of the store's categories (404 if unknown or cross-tenant)",
  "unitId": "string | null — optional; the id of one of the store's units (404 if unknown or cross-tenant)",
  "initialStock": "number — optional, integer 1-1000000; ONLY for variant-less products (400 when combined with variants/options); seeds an INITIAL_STOCK ledger entry",
  "variants": ["Variant create: name (optional — derived from option values when omitted), sellingPrice (optional), sku (optional), initialStock (optional, per-variant seed)"] — optional, max 50,
  "options": ["Option create: { name (required, 1-40), values (1-40 strings, each 1-40 chars) }"] — optional, max 2; generates the variant grid
}
```

`initialStock`, `variants`, and `options` are mutually exclusive:
`initialStock` is variant-less-only, while `variants` (explicit list) and
`options` (dimensions → auto-generated grid) are two ways to define
variants. Setting an incompatible pair is rejected with
`400 VALIDATION_ERROR`. A variant-less `initialStock` seeds the product's
starting stock (one `INITIAL_STOCK` ledger entry); a variant's own
`initialStock` seeds that variant's stock the same way. Products without
any initialStock start at 0.

When `options` is supplied the backend generates the full **cartesian
product** of the option values (e.g. `Colour[Red,Blue] × Size[S,M]` → 4
variants), each getting its own row, its option links, and a default-branch
`BranchStock` row. Each variant is created with a derived `name`
(`"Red / M"`) unless a `name` is supplied. The combined grid must not
exceed **50 variants**.

Variants are **editable after creation** (see "Product options & variants"):
dimensions are changed only through `PUT /options`, individual variants can
be re-priced/re-SKU'd/re-labelled, and unwanted variants are **archived**
(soft-retired), never hard-deleted — order and ledger history reference
them. When a product has variants the product's own `quantity` is inert —
its stock is the sum of its variants' quantities, each moved independently.

Every created product also gets its default branch's `BranchStock` rows and
an initial `product.created` activity log entry.

Success: `201` — the Product shape above.

## GET /api/dashboard/products

Query params:
- `limit: number — optional, default 50, min 1, max 200`
- `cursor: string (product id) — optional; the first item after the cursor, returned by the previous response`

Returns only non-deleted products of the authenticated store, ordered by
`createdAt DESC, id DESC` (stable under inserts).

Success: `200`

```json
{
  "items": ["Product shape"],
  "nextCursor": "string | null — present only when more items follow the returned page",
  "total": "number — count of all non-deleted products of the store"
}
```

List rows additionally carry `salesCount`: the number of line items
ever sold for the product (`orderLineItem` rows across all order
statuses, variants included). It is list-only — detail and create
responses do not include it.

## GET /api/dashboard/products/:productId

Success: `200` — Product shape.
`404 NOT_FOUND` when the product does not exist in the tenant (including
cross-tenant ids and soft-deleted products).

## PATCH /api/dashboard/products/:productId

Body: any subset of `name`, `sku`, `price`, `costPrice`, `shippingWeightKg`, `description`,
`images`, `coverImageUrl`, `discountPrice`, `lowStockThreshold`,
`expiryDate`, `categoryId`, `unitId` (same rules as create). Absent
fields are unchanged; `sku: null`, `costPrice: null`, `description: null`,
`coverImageUrl: null`, `discountPrice: null`, `categoryId: null`,
`unitId: null` clear them.
`quantity`, `initialStock`, `variants`, and `options` are NEVER accepted
here — stock changes only via the stock-adjustment endpoint, `initialStock`
is create-only, and variants/options are managed through the dedicated
`PUT /options` and `/variants` routes (see "Product options & variants").

A `discountPrice` set without a new `price` is validated against the
product's CURRENT price (a discount must discount) — rejected with `400
VALIDATION_ERROR` when it is not lower.

**Cloudinary cleanup:** removing a Cloudinary URL from `images`/`coverImageUrl`
automatically destroys that asset (best-effort, fire-and-forget). Cleanup
failures never fail the update. Only URLs under the store's own Cloudinary
folder are touched — external or other-tenant URLs are ignored.

Success: `200` — Product shape.
`404 NOT_FOUND` for unknown / cross-tenant / soft-deleted products.

## POST /api/dashboard/products/:productId/publish

Marks the product buyable at public checkout. No body.

**Publish gate** — a product cannot go live unless it is ready to be shown
and sold. Publishing a DRAFT product without every one of the following is
rejected with `409 PRODUCT_NOT_READY_TO_PUBLISH` (message lists exactly
what is missing):

- `categoryId` — a category must be assigned
- `unitId` — a unit must be assigned
- a product photo — `coverImageUrl` set, OR at least one entry in `images`

(`name` and `price` are DB-required at create, so they can never be the
blocking gap.)

Publishing an already-PUBLISHED product is a silent no-op (`200`, the gate
is not re-run) — safe to retry.

Success: `200` — Product shape, with `status: "PUBLISHED"`.
`404 NOT_FOUND` for unknown / cross-tenant / soft-deleted products.

## POST /api/dashboard/products/:productId/unpublish

Returns the product to DRAFT: it disappears from public checkout but stays
in the inventory list and retains its stock. No body. Idempotent like
publish.

Success: `200` — Product shape, with `status: "DRAFT"`.
`404 NOT_FOUND` for unknown / cross-tenant / soft-deleted products.

## DELETE /api/dashboard/products/:productId

Soft-deletes the product (`deletedAt` set; the row is kept because order and
ledger history reference it — `Restrict` foreign keys make hard deletion
impossible by design). Deleted products disappear from list/get and reject all
further mutations. Soft-deleting also triggers best-effort, fire-and-forget
cleanup of the product's Cloudinary image assets (same tenant-scoping rules as
`PATCH` — only the store's own Cloudinary URLs are destroyed). The `204`
response is unaffected by cleanup success or failure.

Success: `204` (idempotent — deleting an already-deleted product also returns
`204`).
`404 NOT_FOUND` for ids that never existed in the tenant.

## Product options & variants

Dimensions (up to **2**) are defined with `PUT /options`; the backend
generates the variant grid from the cartesian product. Individual variants
are then edited, archived, or restored. All routes require
`products.manage`, are rate-limited `60/min`, and scope to the tenant
(unknown / cross-tenant / soft-deleted product or variant → `404`).

## PUT /api/dashboard/products/:productId/options

Reconciles the product's option dimensions and regenerates the variant
grid in ONE transaction.

Body:

```json
{
  "options": [
    { "name": "Colour", "values": ["Red", "Blue"] },
    { "name": "Size", "values": ["S", "M", "L"] }
  ]
}
```

- Max **2** options; each option 1-40 chars; each value 1-40 chars, trimmed,
  non-empty, de-duplicated case-insensitively within its option. Any
  characters are allowed (the platform does not restrict to a colour list).
- The generated grid must not exceed **50 variants** (`409 VARIANT_LIMIT_REACHED`).
- **Reconcile semantics:** combinations that already exist are **preserved**
  (their `sellingPrice`, `sku`, per-branch stock, and archive state are kept —
  matching is by the variant's option-value set, so renaming a value keeps its
  variants); missing combinations are **created**; combinations dropped from
  the definition are **archived** (never deleted).
- Sending `{ "options": [] }` removes all dimensions; every existing variant is
  archived and the product reverts to a variant-less product (its stock stays
  0 until adjusted via the stock endpoint).

Success: `200` — the Product shape (with the updated `options` + `variants`).

## POST /api/dashboard/products/:productId/variants

Adds a single variant outside the grid (e.g. a one-off). Body:
`{ name?, sellingPrice?, sku?, initialStock?, optionValues?: [{ option: "Colour", value: "Green" }] }`.
`optionValues` names existing option dimensions + a value; a value not yet in
the dimension is created. Enforces the 50-variant cap.

Success: `201` — the Product shape.

## PATCH /api/dashboard/products/:productId/variants/:variantId

Body: any subset of `name`, `sellingPrice` (nullable), `sku` (nullable).
Absent fields are unchanged; null clears. **Option values are not editable
here** — change them via `PUT /options`.

Success: `200` — the Product shape.

## POST /api/dashboard/products/:productId/variants/:variantId/archive

Retires a variant: sets `archivedAt`. It disappears from the public
storefront and is rejected at checkout / POS / new purchase-order lines, but
its history and stock rows are kept and it can still receive stock
adjustments (write-offs). Idempotent.

Success: `200` — the Product shape.

## POST /api/dashboard/products/:productId/variants/:variantId/restore

Clears `archivedAt`; the variant becomes sellable again. Idempotent.

Success: `200` — the Product shape.

## POST /api/dashboard/products/bulk/import

Two-phase bulk import. This phase **writes nothing** — it validates every
row, flags duplicates, and returns a ticket (`importId`) for the confirm
phase. Rate-limited: `60/min`.

Only `name` and `price` are required per row. Every other field is
**voluntary** — omitted, empty, or null are all equivalent: empty
`costPrice`/`description`/`coverImageUrl` → stored `null`; empty `images` →
`[]`; empty `categoryId`/`unitId` → the product is imported uncategorized
(DRAFT — the publish gate blocks go-live until assigned); empty
`initialStock` → the product starts at 0 with no `INITIAL_STOCK` ledger
entry.

Body:

```json
{
  "rows": [
    {
      "name": "string — required, trimmed, 1-120 chars",
      "price": "number or string — required, > 0, at most 2 decimal places, max 99999999.99",
      "costPrice": "number or string | null — voluntary, >= 0, at most 2 decimal places",
      "description": "string | null — voluntary, up to 2000 chars",
      "images": "string[] — voluntary, max 10 URLs",
      "coverImageUrl": "string | null — voluntary, valid URL, up to 2048 chars",
      "categoryId": "string | null — voluntary; must belong to the store (404 otherwise)",
      "unitId": "string | null — voluntary; must belong to the store (404 otherwise)",
      "initialStock": "number — voluntary, integer 1-1000000"
    }
  ]
}
```

- `rows` must contain 1-500 entries.
- Duplicates are matched against the store's existing (non-deleted)
  products by **case-insensitive name**; two rows in the SAME import that
  collide are flagged too (the later row is the duplicate).
- A row missing `name` or `price`, or with an invalid field, is flagged
  `error` with its reasons — it never blocks the other rows, and it can
  never be confirmed.

Success: `200`

```json
{
  "importId": "string — uuid (v7); the ticket for /bulk/confirm",
  "rows": [
    {
      "rowNumber": "number — 1-based position in the submitted array",
      "status": "\"new\" | \"duplicate\" | \"error\"",
      "errors": ["string — per-row reasons; empty unless status is \"error\""],
      "existingProductId": "string | null — set only for duplicates of an existing product (null for intra-import duplicates)",
      "existingName": "string | null — set only for duplicates",
      "product": {
        "name": "string — trimmed",
        "price": "string — 2dp decimal",
        "costPrice": "string | null — 2dp decimal",
        "description": "string | null",
        "images": ["string — URLs"],
        "coverImageUrl": "string | null",
        "categoryId": "string | null",
        "unitId": "string | null",
        "initialStock": "number | null — integer 1-1000000"
      } | null — set only for \"new\" rows (the normalized values that WILL be created on confirm; validated, NOT persisted — there is no id/status/quantity yet)"
    }
  ],
  "summary": {
    "new": "number",
    "duplicates": "number",
    "errors": "number"
  },
  "expiresAt": "string — UTC ISO-8601; the importId is rejected after this (default 24h)"
}
```

## POST /api/dashboard/products/bulk/confirm

Applies an import ticket. Only rows the merchant explicitly resolves are
touched — duplicates are **never overwritten silently**. One transaction:
new rows create products (with eager `BranchStock` rows and `INITIAL_STOCK`
ledger entries), confirmed overwrites update existing products (stock is
never touched), and one `bulk.imported` activity entry is written. If
anything fails, nothing is applied.

Body:

```json
{
  "importId": "string — required, the ticket from /bulk/import",
  "resolveDuplicates": {
    "rowNumber": "\"skip\" | \"overwrite\""
  }
}
```

Semantics:

- `skip` — the existing product is left untouched (the default for any
  duplicate not listed).
- `overwrite` — the existing product is updated to the row's fields
  (`name`, `price`, `costPrice`, `description`, `images`, `coverImageUrl`,
  `categoryId`, `unitId`). `initialStock` is ignored on overwrite — stock
  only ever moves through the ledger.
- Rows with `status: "error"` are never writable; listing one is a `400
  VALIDATION_ERROR`.
- A `new` row whose name now collides with a product created AFTER the
  import is a `409 DUPLICATE_NAME` — re-run the import preview.
- The plan's `productCap` is enforced inside the transaction: creating the
  new rows past the cap rolls everything back (`409 PRODUCT_LIMIT_REACHED`).

Success: `200`

```json
{
  "importId": "string",
  "created": ["Product shape"],
  "overwritten": ["Product shape"],
  "skipped": ["number — rowNumbers of untouched duplicates"],
  "failed": ["number — always empty on success"]
}
```

## Error responses

| Status | Code                      | Condition                                              |
| ------ | ------------------------- | ------------------------------------------------------ |
| `400`  | `VALIDATION_ERROR`        | Malformed body/query; `initialStock` combined with `variants`; a `discountPrice` not lower than the (current) price; bulk confirm lists an error row or unknown rowNumber; bulk confirm references a category/unit (or an overwrite target) that no longer belongs to the store |
| `401`  | `UNAUTHORIZED`            | Missing/invalid token, or no store association         |
| `403`  | `INSUFFICIENT_PERMISSIONS`| Authenticated but lacks `products.manage`              |
| `404`  | `NOT_FOUND`               | Unknown, cross-tenant, or soft-deleted product         |
| `404`  | `IMPORT_NOT_FOUND`        | Unknown, expired, or confirmed bulk import ticket      |
| `409`  | `STORE_NOT_CONFIGURED`    | Bulk confirm: the store has no default branch          |
| `409`  | `PRODUCT_NOT_READY_TO_PUBLISH` | Publishing a DRAFT product missing a category, unit, or product photo |
| `409`  | `PRODUCT_LIMIT_REACHED`   | Bulk confirm would exceed the plan's productCap; nothing is persisted |
| `409`  | `DUPLICATE_NAME`          | Bulk confirm: a `new` row now collides with a product created after the import |
| `404`  | `VARIANT_NOT_FOUND`       | Unknown / cross-tenant / other-product variant |
| `409`  | `VARIANT_LIMIT_REACHED`   | Options/variants would exceed 50 variants for the product |
| `400`  | `VALIDATION_ERROR`        | >2 options, empty option/value, value longer than 40 chars, or duplicates |

Uniform error body shape (see `docs/api-contracts/README.md`).
