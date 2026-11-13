# Dashboard purchase orders

Route group: dashboard
Auth: bearer + store (`authenticate` + `resolveTenant`) +
`authorize("purchases.manage")` (owners pass implicitly)
Rate-limited: writes (`POST`, `PUT`, `DELETE`, `issue`, `receive`,
`payments`, `cancel`) at `60_000` window / `300` requests; reads are
not rate-limited

The purchasing surface: `PurchaseOrder` rows track goods ordered from a
supplier into one branch. Lifecycle:

- `DRAFT` — editable, deletable, not sent. No number yet.
- `ORDERED` — the supplier was committed to: the store-sequential
  number (`PO-####`, like `INV-####`) is assigned and `orderedAt`
  stamped at issue time; the order is immutable (edits and deletes
  rejected) except receiving and payment.
- `PARTIALLY_RECEIVED` — some lines are in (see receiving below).
- `RECEIVED` — terminal for receiving; every line is fully in.
  `receivedAt` is stamped when the last outstanding quantity lands.
- `CANCELLED` — terminal; entered from `DRAFT` or `ORDERED` only, and
  only while the order has **no receipts** (the ledger-safe way to
  discard an order that will never arrive).

**Receiving is the only way stock enters a purchase order**: every
receipt writes `StockLedgerEntry` rows (`RESTOCK`, `referenceId` =
the purchase order id, into the order's branch), advances
`BranchStock`, and updates the cached product/variant totals — all in
one transaction with the append-only `PurchaseOrderReceipt` ledger.
Nothing else in this module touches stock.

Money values are decimal strings, never floats. All timestamps are UTC
ISO-8601. `total` is the sum of `quantity x unitCostAtOrder`, captured
at create time and never re-read from the product.

## POST /api/dashboard/purchase-orders

Creates a `DRAFT` order with its line items.

### Request

Body:

```json
{
  "supplierId": "uuid — required, must exist in this store",
  "branchId": "uuid — required, must exist in this store; the branch the goods will land in",
  "expectedDeliveryDate": "UTC ISO-8601 date — optional",
  "notes": "string — optional, 1..1000 chars",
  "lineItems": [
    {
      "productId": "uuid — required, must exist in this store",
      "variantId": "uuid — required when the product has variants, forbidden otherwise",
      "quantity": "integer — required, 1..1000000",
      "unitCostAtOrder": "decimal string — required, > 0, max 99999999.99"
    }
  ]
}
```

- At least one line item is required; `total` = Σ `quantity x unitCostAtOrder`.
- A product with variants must be ordered per variant (`variantId`
  required, 404 `VARIANT_NOT_FOUND` on mismatch); a variant-less
  product must not name one. An **archived** variant (retired from the
  storefront) is rejected with `404 VARIANT_NOT_FOUND` — it cannot be
  re-ordered.
- `expectedDeliveryDate` is informational only (no enforcement).

### Success response

Status: `201` — the created order (detail shape below, minus
`number`/`orderedAt`/`receipts`/`payments`, which are empty while
`DRAFT`).

A `purchaseOrder.created` entry is appended to the store activity log.

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Invalid fields, empty `lineItems`. |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `purchases.manage`. |
| `404`  | `SUPPLIER_NOT_FOUND`  | No such supplier in this store.    |
| `404`  | `BRANCH_NOT_FOUND`    | No such branch in this store.      |
| `404`  | `PRODUCT_NOT_FOUND`   | A line item names a product that does not exist in this store. |
| `429`  | `RATE_LIMITED`        | —                                 |

---

## GET /api/dashboard/purchase-orders

Query parameters (all optional):

- `status` — filter by `PurchaseOrderStatus`
  (`DRAFT | ORDERED | PARTIALLY_RECEIVED | RECEIVED | CANCELLED`).
- `supplierId` — filter to one supplier's orders.
- `limit` — `1..100`, default `20`.
- `cursor` — the last `id` of the previous page (uuidv7 ids are
  time-ordered, so `id < cursor` gives the next older page); omitted
  starts at the newest.

Orders are returned newest-first (`createdAt` descending).

### Success response

Status: `200`

```json
{
  "items": [
    {
      "id": "019f...",
      "number": "PO-0001",
      "status": "PARTIALLY_RECEIVED",
      "total": "7500.00",
      "amountPaid": "3000.00",
      "balanceDue": "4500.00",
      "expectedDeliveryDate": "2026-09-01T00:00:00.000Z",
      "itemCount": 2,
      "supplier": { "id": "019f...", "name": "Prime Distributors" },
      "branch": { "id": "019f...", "name": "Main Branch" },
      "createdAt": "2026-08-14T09:00:00.000Z",
      "orderedAt": "2026-08-14T09:05:00.000Z"
    }
  ],
  "nextCursor": "019f... | null"
}
```

- `number` — the store-sequential `PO-####`; `null` while `DRAFT`.
- `nextCursor` — pass as `cursor` to fetch the next page; `null` when
  there are no older orders.

### Error responses

| Status | Code                  | Condition                         |
| ------ | --------------------- | --------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Malformed query (`status`, `supplierId`, `limit`, `cursor`). |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `purchases.manage`. |

---

## GET /api/dashboard/purchase-orders/:purchaseOrderId

One order with its captured line items, receipt timeline, and payment
timeline.

### Success response

Status: `200`

```json
{
  "purchaseOrder": {
    "id": "019f...",
    "number": "PO-0001",
    "status": "PARTIALLY_RECEIVED",
    "total": "7500.00",
    "amountPaid": "3000.00",
    "balanceDue": "4500.00",
    "notes": null,
    "expectedDeliveryDate": "2026-09-01T00:00:00.000Z",
    "supplier": { "id": "019f...", "name": "Prime Distributors" },
    "branch": { "id": "019f...", "name": "Main Branch" },
    "createdAt": "2026-08-14T09:00:00.000Z",
    "orderedAt": "2026-08-14T09:05:00.000Z",
    "receivedAt": null,
    "cancelledAt": null
  },
  "lineItems": [
    {
      "id": "019f...",
      "productId": "019f...",
      "productName": "Palm Oil 5L",
      "variantId": null,
      "variantName": null,
      "quantity": 10,
      "quantityReceived": 4,
      "remainingToReceive": 6,
      "unitCostAtOrder": "500.00",
      "lineTotal": "5000.00"
    }
  ],
  "receipts": [
    {
      "id": "019f...",
      "note": "First drop",
      "recordedByName": "Chidi Manager",
      "createdAt": "2026-08-15T10:00:00.000Z",
      "lines": [
        {
          "productId": "019f...",
          "productName": "Palm Oil 5L",
          "variantId": null,
          "variantName": null,
          "quantityReceived": 4,
          "unitCostAtReceipt": "500.00"
        }
      ]
    }
  ],
  "payments": [
    {
      "id": "019f...",
      "amount": "3000.00",
      "note": "Advance",
      "recordedByName": "Chidi Manager",
      "createdAt": "2026-08-15T11:00:00.000Z"
    }
  ]
}
```

- `lineItems[].remainingToReceive` = `quantity - quantityReceived`.
- `receipts` — the append-only receiving ledger, oldest first.
- `payments` — the append-only payment ledger, oldest first.

### Error responses

| Status | Code                    | Condition                              |
| ------ | ----------------------- | -------------------------------------- |
| `401`  | `UNAUTHORIZED`          | Missing, malformed, or expired token.   |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `purchases.manage`. |
| `404`  | `PURCHASE_ORDER_NOT_FOUND` | No such order in this store.          |

---

## PUT /api/dashboard/purchase-orders/:purchaseOrderId

Full replace of a `DRAFT` order (same rules as `POST`, line items
replaced wholesale; `total` recomputed). Rejected for any issued
order — an `ORDERED` order is immutable.

### Success response

Status: `200` — the updated order (detail shape). A
`purchaseOrder.updated` entry is appended to the store activity log.

### Error responses

| Status | Code                    | Condition                              |
| ------ | ----------------------- | -------------------------------------- |
| `400`  | `VALIDATION_ERROR`      | Invalid fields, empty `lineItems`.     |
| `409`  | `ORDER_NOT_EDITABLE`    | The order is not `DRAFT`.              |
| `404`  | `PURCHASE_ORDER_NOT_FOUND` | No such order in this store.          |
| `404`  | `SUPPLIER_NOT_FOUND` / `BRANCH_NOT_FOUND` / `PRODUCT_NOT_FOUND` | References outside the tenant. |
| `429`  | `RATE_LIMITED`          | —                                      |

---

## DELETE /api/dashboard/purchase-orders/:purchaseOrderId

Deletes a `DRAFT` order (with its line items). Rejected otherwise —
issued orders are cancelled, never deleted.

### Success response

Status: `204`, empty body. A `purchaseOrder.deleted` entry is appended
to the store activity log.

### Error responses

| Status | Code                    | Condition                          |
| ------ | ----------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`          | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `purchases.manage`. |
| `404`  | `PURCHASE_ORDER_NOT_FOUND` | No such order in this store.      |
| `409`  | `ORDER_NOT_EDITABLE`    | The order is not `DRAFT`.          |
| `429`  | `RATE_LIMITED`          | —                                  |

---

## POST /api/dashboard/purchase-orders/:purchaseOrderId/issue

Commits a `DRAFT` order to the supplier: assigns the store-sequential
`PO-####` number, stamps `orderedAt`, and moves it to `ORDERED`. From
here the order is immutable (except receiving, payment, and
cancellation). Numbers are assigned inside the issue transaction and
never reused.

### Success response

Status: `200` — the order's detail shape with `status: "ORDERED"`.

A `purchaseOrder.issued` entry is appended to the store activity log.

### Error responses

| Status | Code                    | Condition                          |
| ------ | ----------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`          | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `purchases.manage`. |
| `404`  | `PURCHASE_ORDER_NOT_FOUND` | No such order in this store.      |
| `409`  | `ORDER_NOT_EDITABLE`    | The order is not `DRAFT` (already issued, received, or cancelled). |
| `429`  | `RATE_LIMITED`          | —                                  |

---

## POST /api/dashboard/purchase-orders/:purchaseOrderId/receive

Records a partial or full delivery against an `ORDERED` /
`PARTIALLY_RECEIVED` order, in the order's branch. One transaction:

1. A `PurchaseOrderReceipt` row (the append-only header) plus its
   lines are written.
2. Each line advances `quantityReceived` on the matching order line
   (never past `quantity`).
3. Each line writes a `StockLedgerEntry` movement (`RESTOCK`,
   `referenceId` = the order id, `performedByStaffId` = the caller,
   into the order's branch) via the stock-ledger transaction —
   `BranchStock` and the cached product/variant totals advance with
   it.
4. The order's status recomputes: all lines fully in →
   `RECEIVED` (stamping `receivedAt`); any line partially in →
   `PARTIALLY_RECEIVED`.

`unitCostAtReceipt` is copied from the order line's `unitCostAtOrder`
(cost drift at delivery is out of scope for this phase).

### Request

Body:

```json
{
  "note": "string — optional, 1..1000 chars",
  "lineItems": [
    {
      "lineItemId": "uuid — required, a line of THIS order",
      "quantityReceived": "integer — required, 1..1000000, never more than the line's remainingToReceive"
    }
  ]
}
```

- At least one line item is required; every line must belong to this
  order and must still have quantity outstanding.

### Success response

Status: `200` — the order's detail shape (receipts and line items
updated; `status` reflects the new receiving state).

A `purchaseOrder.received` entry is appended to the store activity
log.

### Error responses

| Status | Code                    | Condition                              |
| ------ | ----------------------- | -------------------------------------- |
| `400`  | `VALIDATION_ERROR`      | Invalid fields, empty `lineItems`, over-receipt. |
| `401`  | `UNAUTHORIZED`          | Missing, malformed, or expired token.  |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `purchases.manage`. |
| `404`  | `PURCHASE_ORDER_NOT_FOUND` | No such order in this store.          |
| `404`  | `LINE_ITEM_NOT_FOUND`   | A `lineItemId` does not belong to this order. |
| `409`  | `ORDER_NOT_RECEIVABLE`  | The order is `DRAFT`, `RECEIVED`, or `CANCELLED`. |
| `429`  | `RATE_LIMITED`          | —                                      |

---

## POST /api/dashboard/purchase-orders/:purchaseOrderId/payments

Records a payment to the supplier against an `ORDERED` /
`PARTIALLY_RECEIVED` / `RECEIVED` order. Money moves through the
append-only `PurchaseOrderPayment` ledger: `amountPaid` advances with
each row, and a payment can never exceed `balanceDue`. There is no
`PAID` status — payment and receiving are independent; the order's
`balanceDue` is the money picture.

### Request

Body:

```json
{
  "amount": "decimal string — required, > 0, max 99999999.99, never more than balanceDue",
  "note": "string — optional, 1..500 chars"
}
```

### Success response

Status: `200`

```json
{
  "amount": "3000.00",
  "allocated": "3000.00",
  "balanceDue": "4500.00"
}
```

A `purchaseOrder.payment.recorded` entry is appended to the store
activity log.

### Error responses

| Status | Code                    | Condition                              |
| ------ | ----------------------- | -------------------------------------- |
| `400`  | `VALIDATION_ERROR`      | Invalid fields.                        |
| `400`  | `PAYMENT_EXCEEDS_BALANCE` | The amount exceeds `balanceDue`.     |
| `401`  | `UNAUTHORIZED`          | Missing, malformed, or expired token.  |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `purchases.manage`. |
| `404`  | `PURCHASE_ORDER_NOT_FOUND` | No such order in this store.          |
| `409`  | `ORDER_NOT_PAYABLE`     | The order is `DRAFT` or `CANCELLED`.   |
| `429`  | `RATE_LIMITED`          | —                                      |

---

## POST /api/dashboard/purchase-orders/:purchaseOrderId/cancel

Cancels a `DRAFT` or `ORDERED` order. Allowed only while the order has
**no receipts** (an order that started arriving cannot be cancelled —
its ledger rows are the record; `RECEIVED` orders are simply done).
Stamps `cancelledAt`.

### Success response

Status: `200` — the order's detail shape with `status: "CANCELLED"`.

A `purchaseOrder.cancelled` entry is appended to the store activity
log.

### Error responses

| Status | Code                    | Condition                              |
| ------ | ----------------------- | -------------------------------------- |
| `401`  | `UNAUTHORIZED`          | Missing, malformed, or expired token.  |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `purchases.manage`. |
| `404`  | `PURCHASE_ORDER_NOT_FOUND` | No such order in this store.          |
| `409`  | `ORDER_NOT_CANCELLABLE` | The order is `PARTIALLY_RECEIVED`, `RECEIVED`, or already `CANCELLED`. |
| `429`  | `RATE_LIMITED`          | —                                      |

---

Uniform error body shape (see `docs/api-contracts/README.md`).