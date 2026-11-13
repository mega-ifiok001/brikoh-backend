# POST /api/dashboard/products/:productId/stock-adjustments

Route group: dashboard
Auth: bearer + store
Rate-limited: no

Adjusts a product's stock by a signed quantity and appends one
`StockLedgerEntry` row. This is the ONLY approved way to change stock — the
`quantity` field is never writable directly through the product update
endpoint. The product update and the ledger insert happen in a single
database transaction: if the adjustment is rejected, no ledger row is
written.

The tenant comes from `req.tenant.storeId`; the ledger's
`performedByStaffId` is the authenticated staff member's id (null for
owners).

Stock is per-branch: every movement names the branch it happens in, and the
ledger row records it. The movement targets the named branch's `BranchStock`
row (the branch's row is auto-created for restocks when it is missing, e.g.
a branch created after the product).

## Request

Path params:
- `productId: string`

Body:

```json
{
  "branchId": "string — REQUIRED; the branch the movement happens in (the branch's BranchStock row is the movement target)",
  "quantityChange": "number — integer, != 0 (positive = restock, negative = decrement)",
  "reason": "MANUAL_ADJUSTMENT | RESTOCK | REFUND | WRITE_OFF",
  "variantId": "string — optional; REQUIRED when the product has variants",
  "referenceId": "string — optional; free-form pointer to the movement's source document (e.g. a purchase order id); no foreign key"
}
```

`SALE` is NOT accepted here: sale movements originate exclusively from the
order-fulfillment flow, so `SALE` entries in the ledger can always be trusted
to correspond to real orders. Posting `SALE` manually is rejected with
`400 INVALID_STOCK_REASON`.

Variants: a product that has variants has NO product-level stock — its
`quantity` is inert and every movement must name one of its variants. A
product-level adjustment on a variant product is rejected with
`400 VARIANT_REQUIRED`; naming a variant of another product (or another
store's variant) is `404 VARIANT_NOT_FOUND`.

**Archived variants stay adjustable.** A variant retired from the storefront
(`archivedAt` set) still holds real stock, so it can still receive
adjustments (e.g. a write-off). Archiving a variant never blocks its stock
endpoint — it only stops it being sold.

## Concurrency guarantee

Decrements are applied with an atomic conditional update
(`UPDATE ... SET quantity = quantity - n WHERE quantity >= n`) on the
named branch's `BranchStock` row inside the transaction — or on the
variant's row when `variantId` is given. Two concurrent adjustments that
would individually succeed but together over-sell can never both commit:
the second one is rejected and its transaction (including its ledger
insert) rolls back.

## Success response

Status: `200`

```json
{
  "product": {
    "id": "string — product id",
    "name": "string",
    "quantity": "number — cached product-level stock, >= 0 (always 0 for variant products; not the branch number)"
  },
  "variant": {
    "id": "string",
    "name": "string",
    "quantity": "number — resulting variant stock, >= 0"
  } | null,
  "branchStockAfter": "number — THE authoritative result: the named branch's stock after the movement",
  "ledgerEntry": {
    "id": "string",
    "variantId": "string | null",
    "quantityChange": "number — signed, != 0",
    "reason": "string — one of StockReason",
    "referenceId": "string | null",
    "performedByStaffId": "string | null",
    "createdAt": "string — UTC ISO-8601"
  }
}
```

Variant adjustments return a `variant` object; product-level adjustments
return `variant: null`.

## Error responses

| Status | Code                  | Condition                                              |
| ------ | --------------------- | ------------------------------------------------------ |
| `400`  | `VALIDATION_ERROR`    | Malformed body (e.g. `quantityChange: 0`, missing `branchId`, non-string `variantId`) |
| `400`  | `INVALID_STOCK_REASON`| `reason: SALE`, `reason: INITIAL_STOCK`, or any unknown reason |
| `400`  | `VARIANT_REQUIRED`    | Product has variants but no `variantId` was given      |
| `401`  | `UNAUTHORIZED`        | Missing/invalid token, or no store association         |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Lacks `products.manage`                           |
| `404`  | `NOT_FOUND`           | Unknown, cross-tenant, or soft-deleted product         |
| `404`  | `VARIANT_NOT_FOUND`   | Variant belongs to another product or store            |
| `404`  | `BRANCH_NOT_FOUND`    | Unknown or cross-tenant branch                         |
| `409`  | `INSUFFICIENT_STOCK`  | Decrement would drive the branch's stock below zero; nothing is persisted |

Uniform error body shape (see `docs/api-contracts/README.md`).
