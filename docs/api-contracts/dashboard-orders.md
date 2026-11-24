# GET /api/dashboard/orders & GET /api/dashboard/orders/:orderId

Route group: dashboard

Auth:

- Bearer + store (`resolveTenant`)
- Permission: `orders.manage` (owners pass implicitly — same trust level
  as the POS record-sale route)
- Rate-limited: no (read-only over the tenant's own order history)

Orders list and detail over ALL of the store's orders — POS sales
(`source: POS`) and storefront checkouts (`source: STOREFRONT`) alike,
across every status. Money values are decimal strings, never floats.

**Customer receipts:** a customer receipt email is sent after a successful
payment (storefront card/bank-transfer, POS card) when the store has
`receiptsEnabled` on and the order captured a customer email
(`Order.receiptEmail`). See `dashboard-settings.md` → "Customer receipts".

Every order carries a store-sequential `orderNumber` (`ORD-####`,
padded to 4 digits — `ORD-0001`, `ORD-0002`, …). Numbers are assigned
at creation inside the same transaction that creates the order (the
store's `orderCounter` bumps atomically, the same counter pattern as
invoices and purchase orders), so they are gap-free per store, never
reused, and stable for life. Existing orders were backfilled at
migration time in `createdAt` order; the number is immutable once
assigned.

## GET /api/dashboard/orders

Query parameters (all optional):

- `status` — filter by `OrderStatus` (`PENDING | AWAITING_PAYMENT |
PAID | SHIPPED | CANCELLED | REFUNDED | FAILED`). `AWAITING_PAYMENT`
  is specific to bank-transfer orders awaiting merchant confirmation
  (see below).
- `paymentMethod` — filter by `CASH | TRANSFER | CREDIT | CARD` (POS
  sales only; storefront orders have no payment method).
- `source` — filter by `OrderSource` (`STOREFRONT | POS | DIRECT |
SOCIAL | MARKETPLACE | REFERRAL`).
- `date` — optional `YYYY-MM-DD`; filters orders to that UTC calendar day.
- `q` — case-insensitive substring match on the customer's name or
  phone.
- `customerId` — filter to one customer's orders (address-book
  integration, see `dashboard-customers.md`).
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
      "orderNumber": "ORD-0007",
      "status": "PAID",
      "paymentMethod": "CASH",
      "source": "POS",
      "total": "1250.00",
      "discountAmount": "0.00",
      "discountId": null,
      "amountPaid": "1250.00",
      "balanceDue": "0.00",
      "itemCount": 2,
      "customer": { "id": "019f...", "name": "Ade Okafor", "phone": "+234..." },
      "branch": { "id": "019f...", "name": "Main Branch" },
      "soldBy": { "id": "019f...", "name": "Chidi Manager" },
      "createdAt": "2026-08-12T10:00:00.000Z"
    }
  ],
  "nextCursor": "019f... | null"
}
```

- `balanceDue` — the outstanding credit balance for `CREDIT` orders
  (`total - amountPaid`); `0.00` for every other payment method.
- `orderNumber` — the store-sequential `ORD-####` number, unique per
  store and immutable once assigned.
- `discountId` — the managed discount applied at sale time
  (`dashboard-discounts.md`); `null` for undiscounted orders and for
  orders discounted before this feature shipped. `discountAmount` is the
  captured money fact; `discountId` is informational and may reference a
  since-deleted discount.
- `soldBy` — the staff member who recorded the sale (POS); `null` for
  storefront orders and owner-recorded sales.
- `delivery` — the **frozen** fulfilment snapshot for storefront orders that
  chose a delivery option (`dashboard-delivery-options.md`): the option name,
  the customer's address (null for `PICKUP`), and the fee (already included
  in `total`). `null` for POS orders, orders with no delivery option, and
  orders placed before the feature. `kind` is `PICKUP` or `DELIVERY`.
- `nextCursor` — pass as `cursor` to fetch the next page; `null` when
  there are no older orders.

### Error responses

| Status | Code                       | Condition                                                                       |
| ------ | -------------------------- | ------------------------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`         | Malformed query (invalid `date`, bad `limit`, or unsupported range parameters). |
| `401`  | `UNAUTHORIZED`             | Missing, malformed, or expired token.                                           |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `orders.manage`.                                             |

Uniform error body shape (see `docs/api-contracts/README.md`).

## GET /api/dashboard/orders/:orderId

Returns one order with its captured line items.

### Success response

Status: `200`

```json
{
  "order": {
    "id": "019f...",
    "orderNumber": "ORD-0007",
    "status": "PAID",
    "paymentMethod": "CASH",
    "source": "POS",
    "total": "1250.00",
    "discountAmount": "0.00",
    "discountId": null,
    "amountPaid": "1250.00",
    "balanceDue": "0.00",
    "customer": { "id": "019f...", "name": "Ade Okafor", "phone": "+234..." },
    "branch": { "id": "019f...", "name": "Main Branch" },
    "soldBy": { "id": "019f...", "name": "Chidi Manager" },
    "delivery": {
      "kind": "DELIVERY",
      "optionName": "Delivery Rider",
      "address": "12 Admiralty Way, Lekki",
      "city": "Lagos",
      "state": "Lagos",
      "phone": "08012345678",
      "instructions": "Call on arrival",
      "fee": "2000.00"
    },
    "createdAt": "2026-08-12T10:00:00.000Z"
  },
  "repayments": [
    {
      "id": "019f...",
      "amount": "500.00",
      "note": "Part payment",
      "recordedByName": "Chidi Manager",
      "createdAt": "2026-08-12T12:00:00.000Z"
    }
  ],
  "lineItems": [
    {
      "id": "019f...",
      "productId": "019f...",
      "productName": "Palm Oil 5L",
      "variantId": null,
      "variantName": null,
      "quantity": 2,
      "unitPriceAtPurchase": "550.00",
      "lineTotal": "1100.00"
    }
  ]
}
```

- `lineItems[].lineTotal` = `quantity x unitPriceAtPurchase` —
  `unitPriceAtPurchase` is captured at sale time, never re-read.
- `repayments` — the order's credit-repayment timeline, oldest first
  (`dashboard-customers.md`); `[]` for non-CREDIT orders and orders
  never repaid. `balanceDue` is always consistent with these rows:
  `total - amountPaid` after every repayment.
- Product names are read live (a soft-deleted product's lines still
  render with their captured prices).

### Error responses

| Status | Code                       | Condition                             |
| ------ | -------------------------- | ------------------------------------- |
| `401`  | `UNAUTHORIZED`             | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `orders.manage`.   |
| `404`  | `ORDER_NOT_FOUND`          | No such order in this store.          |

Uniform error body shape (see `docs/api-contracts/README.md`).

## Bank-transfer confirm / reject (`paymentProvider: "bank_transfer"`)

A storefront `bank_transfer` checkout (`public-checkout.md`) leaves the order
in `PENDING` with the merchant's bank details and a `BRK-` reference frozen
onto it. The buyer later signals payment via `POST /api/public/orders/:orderId/mark-paid`
(`public-orders.md`), moving the order to `AWAITING_PAYMENT`. The merchant
confirms or rejects from the dashboard here.

The order detail for an awaiting order exposes `paymentProvider: "bank_transfer"`,
the frozen `bankDetails`, and `paymentReference` (the `BRK-` string the buyer
quoted), so the merchant can reconcile the incoming transfer.

### POST /api/dashboard/orders/:orderId/confirm-payment

Confirms a claimed bank transfer. The order's `confirmedAmount` is checked
against `order.total`; on match the order is atomically marked `PAID` and
stock is decremented (with the same append-only ledger guard as the Paystack
webhook). **No wallet credit is issued** for manual bank transfers. On
success a `PAYMENT_RECEIVED` alert fires.

Body:

```json
{ "confirmedAmount": 1250.0 }
```

`confirmedAmount` is optional; when omitted the order total is used.

### Success response — `200`

The full `OrderDetail` (same shape as `GET /api/dashboard/orders/:orderId`),
now with `status: "PAID"` and `amountPaid` set.

### Error responses

| Status | Code                         | Condition                                                                                                  |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `401`  | `UNAUTHORIZED`               | Missing/invalid token                                                                                      |
| `403`  | `INSUFFICIENT_PERMISSIONS`   | Staff role without `orders.manage`                                                                         |
| `404`  | `ORDER_NOT_FOUND`            | No such order in this store                                                                                |
| `422`  | `AMOUNT_MISMATCH`            | The `confirmedAmount` does not equal `order.total`                                                         |
| `409`  | `ORDER_NOT_AWAITING_PAYMENT` | Order is not in `AWAITING_PAYMENT` (already `PAID`, `PENDING`, etc.)                                       |
| `409`  | `CONFIRM_CONFLICT`           | A concurrent confirm or the expiry sweep already moved the order (race-safe — exactly one transition wins) |

### POST /api/dashboard/orders/:orderId/reject-payment

Rejects a claimed payment, moving `AWAITING_PAYMENT → PENDING` so the buyer
can retry. No stock movement, no wallet change.

### Success response — `200`

The `OrderDetail`, now `status: "PENDING"`.

### Error responses

| Status | Code                         | Condition                          |
| ------ | ---------------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`               | Missing/invalid token              |
| `403`  | `INSUFFICIENT_PERMISSIONS`   | Staff role without `orders.manage` |
| `404`  | `ORDER_NOT_FOUND`            | No such order in this store        |
| `409`  | `ORDER_NOT_AWAITING_PAYMENT` | Order is not in `AWAITING_PAYMENT` |

## Bank-transfer auto-expiry sweep

An `AWAITING_PAYMENT` order whose claim (`paymentSubmittedAt`) is older than
the configured max age is automatically reclaimed to `PENDING` by a
server-side sweep, so a merchant's queue can't fill with stale or false
claims. Configuration (server env):

- `EXPIRY_SWEEP_INTERVAL_MS` — how often the sweep runs (default `1h`).
- `EXPIRY_SWEEP_MAX_AGE_MS` — claim age before reclaim (default `12h`).

The reclaim and a concurrent merchant confirm both guard on
`status: "AWAITING_PAYMENT"`, so they can never both apply — exactly one
transition wins, never a partial double-apply. The sweep is a no-op under
`NODE_ENV=test`.

Uniform error body shape (see `docs/api-contracts/README.md`).
