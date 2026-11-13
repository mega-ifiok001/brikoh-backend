# Dashboard suppliers

Route group: dashboard
Auth: bearer + store (`authenticate` + `resolveTenant`) +
`authorize("purchases.manage")` (owners pass implicitly)
Rate-limited: writes (`POST`, `PUT`, `DELETE`) at `60_000` window /
`300` requests; reads are not rate-limited

The vendor directory: `Supplier` rows the purchase-order module draws
from. A supplier is a merchant-defined contact — never an account, never
login-able. `(storeId, name)` is unique per tenant, so the directory
stays typo-free (same rule as categories and units).

Deleting a supplier is ledger-safe: purchase orders keep their
supplier attribution via a DB `RESTRICT` foreign key, so a supplier
with any order history cannot be deleted (`409`). Deactivation
(`isActive: false`) is the supported way to retire a supplier while
keeping its history.

Money values are decimal strings, never floats. All timestamps are UTC
ISO-8601. `balanceDue` = sum over the supplier's non-draft,
non-cancelled purchase orders of `total - amountPaid` — computed at
read time, never stored.

## POST /api/dashboard/suppliers

Creates a supplier.

### Request

Body:

```json
{
  "name": "string — required, 1..100 chars, trimmed",
  "contactName": "string — optional, 1..100 chars",
  "phone": "string — optional, same rule as businessPhone (7-17 digits, may start with +)",
  "email": "string — optional, valid email",
  "address": "string — optional, 1..200 chars",
  "isActive": "boolean — optional, default true",
  "notes": "string — optional, 1..1000 chars"
}
```

### Success response

Status: `201` — the created supplier (detail shape below, minus the
computed summary fields, which are `0`/empty for a fresh supplier).

A `supplier.created` entry is appended to the store activity log.

### Error responses

| Status | Code                    | Condition                              |
| ------ | ----------------------- | -------------------------------------- |
| `400`  | `VALIDATION_ERROR`      | Invalid fields.                        |
| `401`  | `UNAUTHORIZED`          | Missing, malformed, or expired token.  |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `purchases.manage`. |
| `409`  | `SUPPLIER_NAME_TAKEN`   | Another supplier in this store uses the name. |
| `429`  | `RATE_LIMITED`          | —                                      |

---

## GET /api/dashboard/suppliers

The full directory, ordered by `name` ascending. No pagination — a
store's vendor list is small, like categories and units.

### Success response

Status: `200`

```json
{
  "items": [
    {
      "id": "019f...",
      "name": "Prime Distributors",
      "contactName": "Bola Adeyemi",
      "phone": "+234 801 222 3333",
      "email": "sales@primedistributors.example",
      "address": "Lagos Island, Lagos",
      "isActive": true,
      "notes": null,
      "purchaseOrderCount": 3,
      "balanceDue": "4500.00",
      "createdAt": "2026-08-12T10:00:00.000Z",
      "updatedAt": "2026-08-12T10:00:00.000Z"
    }
  ]
}
```

- `purchaseOrderCount` — every purchase order (including `DRAFT` and
  `CANCELLED`).
- `balanceDue` — outstanding money on non-draft, non-cancelled orders
  (`"0.00"` when nothing is owed).

---

## GET /api/dashboard/suppliers/:supplierId

One supplier with its purchase-order history, newest first.

### Success response

Status: `200`

```json
{
  "id": "019f...",
  "name": "Prime Distributors",
  "contactName": "Bola Adeyemi",
  "phone": "+234 801 222 3333",
  "email": "sales@primedistributors.example",
  "address": "Lagos Island, Lagos",
  "isActive": true,
  "notes": null,
  "balanceDue": "4500.00",
  "createdAt": "2026-08-12T10:00:00.000Z",
  "updatedAt": "2026-08-12T10:00:00.000Z",
  "purchaseOrders": [
    {
      "id": "019f...",
      "number": "PO-0003",
      "status": "PARTIALLY_RECEIVED",
      "total": "7500.00",
      "amountPaid": "3000.00",
      "balanceDue": "4500.00",
      "itemCount": 2,
      "createdAt": "2026-08-14T09:00:00.000Z",
      "orderedAt": "2026-08-14T09:05:00.000Z"
    }
  ]
}
```

### Error responses

| Status | Code               | Condition                         |
| ------ | ------------------ | --------------------------------- |
| `401`  | `UNAUTHORIZED`     | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `purchases.manage`. |
| `404`  | `SUPPLIER_NOT_FOUND` | No such supplier in this store.  |

---

## PUT /api/dashboard/suppliers/:supplierId

Full replace of the editable fields (same rules as `POST`), plus
`isActive` — the supported way to deactivate a retired supplier.

### Request

Same body shape as `POST`.

### Success response

Status: `200` — the updated supplier (list shape).

A `supplier.updated` entry is appended to the store activity log.

### Error responses

| Status | Code                  | Condition                            |
| ------ | --------------------- | ------------------------------------ |
| `400`  | `VALIDATION_ERROR`    | Invalid fields.                      |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `purchases.manage`. |
| `404`  | `SUPPLIER_NOT_FOUND`  | No such supplier in this store.      |
| `409`  | `SUPPLIER_NAME_TAKEN` | Another supplier uses the new name.  |
| `429`  | `RATE_LIMITED`        | —                                    |

---

## DELETE /api/dashboard/suppliers/:supplierId

Ledger-safe deletion: allowed only while the supplier has **no**
purchase orders (the DB `RESTRICT` key is the backstop; the service
classifies it as `409`). Retire suppliers with history by setting
`isActive: false` instead.

### Success response

Status: `204`, empty body. A `supplier.deleted` entry is appended to
the store activity log.

### Error responses

| Status | Code                    | Condition                            |
| ------ | ----------------------- | ------------------------------------ |
| `401`  | `UNAUTHORIZED`          | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `purchases.manage`. |
| `404`  | `SUPPLIER_NOT_FOUND`    | No such supplier in this store.      |
| `409`  | `SUPPLIER_HAS_ORDERS`   | The supplier has purchase-order history. |
| `429`  | `RATE_LIMITED`          | —                                    |

---

Uniform error body shape (see `docs/api-contracts/README.md`).