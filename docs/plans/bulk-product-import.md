# Bulk product import — design plan

Status: **implemented** — see `docs/api-contracts/dashboard-products.md` for
the live contract (`POST /api/dashboard/products/bulk/import` and
`POST /api/dashboard/products/bulk/confirm`). This document is the design
record, including the storage decision below.

> **Bulk upload never overwrites existing products silently — duplicates
> must be explicitly flagged and confirmed by the merchant.**

## Business rules this design satisfies

1. Duplicates are never overwritten silently — every duplicate row must be
   explicitly resolved by the merchant before anything is written.
2. All rows are validated before any write happens; a single bad row does
   not partially apply the good ones (atomic import transaction).
3. Imported products go through the same pipeline as single-create:
   `INITIAL_STOCK` ledger entries per row, eager `BranchStock` rows on the
   default branch, `product.created`-style activity attribution.
4. Every import action is attributable to the staff member who ran it
   (`bulk.imported` activity entry with `staffMemberId` — Phase 3 audit).

## Two-phase API (import → confirm)

### Phase 1 — POST /api/dashboard/products/bulk/import

Route group: dashboard · Auth: bearer + store · Permission: `products.manage`
Rate-limited: yes (bulk writes touch payment-adjacent product data and are
write-heavy — same baseline as other dashboard writes).

Body (JSON; CSV upload is an alternative accepted by the same endpoint
later, `Content-Type: text/csv`):

```json
{
  "rows": [
    {
      "name": "string — required, 1-120",
      "price": "number/string — required, same rules as create",
      "costPrice": "number/string | null — optional",
      "description": "string | null — optional",
      "images": ["string — optional, max 10 URLs"],
      "coverImageUrl": "string | null — optional",
      "categoryId": "string | null — optional, tenant-scoped",
      "unitId": "string | null — optional, tenant-scoped",
      "initialStock": "number — optional, integer 1-1000000"
    }
  ]
}
```

This phase **writes nothing**. The server:

- validates every row against the create rules (row numbers in every error);
- resolves `categoryId`/`unitId` tenant ownership;
- detects duplicates against existing products by **case-insensitive
  `(storeId, name)`** (and by `sku` once variants are importable) — the
  same key the unique index enforces;
- produces a per-row disposition.

Success: `200`

```json
{
  "importId": "string — uuid; the ticket for the confirm phase",
  "rows": [
    {
      "rowNumber": "number — 1-based position in the submitted array",
      "status": "\"new\" | \"duplicate\" | \"error\"",
      "errors": ["string — per-row validation/ownership errors; empty when status is not \"error\""],
      "existingProductId": "string | null — set only for duplicates",
      "existingName": "string | null — set only for duplicates",
      "product": {"Product shape"} | null — set only for \"new\" rows (validated, NOT persisted)"
    }
  ],
  "summary": {
    "new": "number",
    "duplicates": "number",
    "errors": "number"
  },
  "expiresAt": "string — UTC ISO-8601; the importId is garbage after this (default 24h)"
}
```

### Phase 2 — POST /api/dashboard/products/bulk/confirm

Body:

```json
{
  "importId": "string — required, the ticket from phase 1",
  "resolveDuplicates": {
    "rowNumber": "\"skip\" | \"overwrite\""
  }
}
```

Semantics:

- `skip` (default for duplicates not listed): the existing product is left
  untouched.
- `overwrite`: the existing product is updated to the row's fields (name,
  price, description, images, coverImageUrl, categoryId, unitId) — an
  **explicit, per-row, merchant-confirmed overwrite**. Overwriting never
  touches stock; `initialStock` on an overwrite is ignored (stock only ever
  moves through the ledger).
- Rows with `status: "error"` are never writable; confirming with an error
  row listed is a `400 VALIDATION_ERROR`.

Then, in ONE transaction:

- every `new` row creates its product, its default-branch `BranchStock`
  rows, and its `INITIAL_STOCK` ledger entry (0 stock when no
  `initialStock`);
- every `overwrite` updates its product;
- one `bulk.imported` activity entry is written:

```json
{
  "action": "bulk.imported",
  "detail": {
    "importId": "string",
    "created": "number",
    "overwritten": "number",
    "skipped": "number",
    "failed": "number"
  }
}
```

Success: `200`

```json
{
  "importId": "string",
  "created": ["Product shape"],
  "overwritten": ["Product shape"],
  "skipped": ["rowNumber"],
  "failed": ["rowNumber"]
}
```

## Error responses

| Status | Code                  | Condition                                          |
| ------ | --------------------- | -------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Malformed body, unknown importId, an error row in the confirm list, an unknown rowNumber, > 500 rows |
| `401`  | `UNAUTHORIZED`        | Missing/invalid token                               |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Lacks `products.manage`                      |
| `404`  | `IMPORT_NOT_FOUND`    | Unknown, expired, or cross-tenant importId          |
| `409`  | `PRODUCT_LIMIT_REACHED` | Creating the new rows would exceed the plan's productCap (checked inside the transaction) |
| `409`  | `DUPLICATE_NAME`      | Two rows in the SAME import collide with each other (detected at import time; the later row is flagged duplicate) |

## Design decisions & rationale

- **DB tables, not stateless signed tickets.** The `importId` is a
  `ProductImport` row (with per-row `ProductImportRow` rows) instead of a
  signed payload, because confirm must re-read live DB state anyway
  (categories, units, stock, plan cap, duplicate collisions) — a ticket's
  precomputed flags would be redundant, while tables give revocation
  (expire/delete the row), an audit trail of preview→confirm, and
  constant-size confirm requests. Same pattern as `InviteToken`.
- **Two phases, no writes in phase 1**: the merchant must see the duplicate
  flags and per-row errors BEFORE anything changes. A single-phase
  "upload and apply" cannot satisfy "explicitly flagged and confirmed".
- **`importId` with expiry**: the preview is a ticket, not a store of data —
  the server re-reads current product state at confirm time, so a product
  created between import and confirm surfaces as a NEW duplicate in the
  confirm response (`409 DUPLICATE_NAME` if a listed `new` row now collides
  — the merchant must re-run the import preview).
- **Voluntary fields**: only `name` and `price` are required per row. The
  other fields (costPrice, description, images, coverImageUrl, categoryId,
  unitId, initialStock) may be omitted, empty, or null — empty maps to
  null/`[]`/0-stock, and category-less/unit-less imports are DRAFT until
  assigned.
- **Atomicity**: one `$transaction` for the whole confirm — a mid-import
  failure (e.g. plan cap) rolls everything back; no partial imports.
- **Overwrite ≠ stock**: `initialStock` is never applied on overwrite.
  Stock changes only via the ledger; the bulk import never writes stock
  except `INITIAL_STOCK` seeds on genuinely new rows.
- **Cap checks inside the transaction** so a concurrent product create
  cannot let the import sneak past the plan gate.

## Explicitly out of scope for v1

- CSV parsing (accept it later as a `text/csv` body variant of the same
  endpoint; the row/error model is identical).
- Variant import (variants remain create-only via the single-product
  endpoint).
- Image file upload — `images`/`coverImageUrl` accept existing URLs only,
  exactly like the single-create endpoint (presign flow unchanged).
- Dry-run diff preview UI concerns (pagination of large imports — the
  contract returns all rows; the frontend paginates locally).
