# POST /api/dashboard/orders — record a POS sale

Route group: dashboard

Auth:

- Bearer + store (`resolveTenant`)
- Permission: `orders.manage` (owners pass implicitly — same trust level
  as the stock-adjustment routes)
- Rate-limited: yes (60/min per route — money-touching, same baseline as
  the payments routes)

Records a point-of-sale transaction: staff create an order directly for
a walk-in or known customer. This is the dashboard counterpart of the
public checkout. **Prices are never client-supplied** — the cart carries
product ids (and optional variant ids) and quantities only:

**Customer receipts:** after a successful POS sale (CARD via the payment
webhook; CASH/TRANSFER/CREDIT instantly) a receipt email is sent to the
customer when the store has `receiptsEnabled` on and a recipient email is
known — the named customer's email, falling back to the request's
`email` field. Walk-in cash sales without an email send nothing. See
`dashboard-settings.md` → "Customer receipts".

- `unitPriceAtPurchase` = `variant.sellingPrice` (when the line names a
  variant and it is set) **else** `product.discountPrice` (when set)
  **else** `product.price` — resolved from the database at record time
  and captured on the line, never re-read afterward.
- Order total = sum of line totals − `discountAmount`. The discount is a
  managed discount (`dashboard-discounts.md`), applied **cart-wide and
  computed server-side** — a client never sends a money amount:
  - An explicit discount: `discountId` or `discountCode` (mutually
    exclusive).
  - Otherwise the chosen customer's **group discount** is auto-applied
    (`dashboard-customer-groups.md`) when the group has an active one.
  - Otherwise no discount (`discountAmount` = `0.00`).
- A `PERCENTAGE` discount computes
  `round(lineTotal * value / 100)`; a `FIXED` discount applies `value`
  capped so the total never goes below `0.00`.

## Request

Headers:

- `Authorization: Bearer <token>`
- `Content-Type: application/json`

Body:

```json
{
  "items": [
    {
      "productId": "uuid — a PUBLISHED, non-deleted product of the store",
      "variantId": "uuid — required when the product has variants",
      "quantity": "integer 1-9999"
    }
  ],
  "branchId": "uuid? — the branch whose stock this sale decrements; defaults to the store's default branch",
  "customerId": "uuid? — omitted for a walk-in sale (the store's shared Walk-in Customer row is used)",
  "paymentMethod": "CASH | TRANSFER | CREDIT | CARD",
  "discountId": "uuid? — an active, in-window discount of this store; mutually exclusive with discountCode",
  "discountCode": "string? — an active, in-window discount code of this store; mutually exclusive with discountId",
  "amountPaid": "0.00-99999999.99? — what the customer paid now; default: the total for CASH/TRANSFER, 0.00 for CREDIT, ignored for CARD",
  "email": "string? — receipt/invoice email for the payment provider; REQUIRED for CARD when the chosen customer has no email (Paystack requires one)"
}
```

## Payment-method semantics

| Method    | Order status on success | Stock                       | Money flow                                  |
| --------- | ----------------------- | --------------------------- | ------------------------------------------- |
| `CASH`    | `PAID` immediately      | decremented atomically      | nothing to reconcile                        |
| `TRANSFER`| `PAID` immediately      | decremented atomically      | nothing to reconcile (bank-side proof)      |
| `CREDIT`  | `PAID` immediately      | decremented atomically      | `amountPaid` kept; balance due = total − amountPaid (credit repayments consume this later) |
| `CARD`    | `PENDING`               | NOT decremented             | Paystack hosted checkout initiated; the existing webhook confirms (PENDING→PAID + decrement) |

Instant methods (`CASH`/`TRANSFER`/`CREDIT`) run in ONE transaction:
the guarded per-branch stock decrement (conditional UPDATE, never
negative — `INSUFFICIENT_STOCK` rolls the whole sale back), the order
row, the sale ledger entries, and the audit entries are atomic. A failed
decrement means no order, no revenue, no ledger — nothing partial.

`CARD` deliberately borrows the storefront contract: the order is
created PENDING, no stock is held, and only the charge.success webhook
makes it PAID and decrements stock — "nothing silently accepted" (same
rule as public checkout). A provider failure leaves a CANCELLED order
and a `502 PAYMENT_PROVIDER_ERROR`.

Sales are attributed to the acting staff member
(`Order.soldByStaffId`) from the token — that is the canonical source
for staff-performance analytics. The order cap (`enforceOrderCap`) is
enforced identically to checkout.

## Success response

Status: `201`

```json
{
  "order": {
    "id": "uuid",
    "status": "PAID",
    "total": "1250.00",
    "discountAmount": "0.00",
    "discountId": null,
    "amountPaid": "1250.00",
    "balanceDue": "0.00",
    "paymentMethod": "CASH",
    "source": "POS",
    "createdAt": "2026-08-12T10:00:00.000Z"
  },
  "payment": null
}
```

For `CARD`, `order.status` is `"PENDING"`, `amountPaid` is `null`, and
the payment half is populated (same shape as public checkout):

```json
{
  "order": {
    "id": "uuid",
    "status": "PENDING",
    "balanceDue": "0.00",
    "discountAmount": "0.00",
    "discountId": null,
    "paymentMethod": "CARD",
    "source": "POS"
  },
  "payment": {
    "provider": "paystack",
    "reference": "ord_…",
    "redirectUrl": "https://checkout.paystack.com/…"
  }
}
```

## Error responses

| Status | Code                     | Condition                                                                                                  |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`       | Malformed body: empty cart, invalid ids/quantities, `discountId` and `discountCode` both supplied, `amountPaid` negative/over-long/over the total, `CARD` without any email for the customer. |
| `400`  | `DISCOUNT_UNAVAILABLE`   | An explicit `discountId`/`discountCode` is not active or is outside its validity window. |
| `404`  | `DISCOUNT_NOT_FOUND`     | An explicit `discountId`/`discountCode` is not a discount of this store. |
| `400`  | `VARIANT_REQUIRED`       | A product with variants was sent without a `variantId`.                                                    |
| `400`  | `VARIANT_NOT_FOUND`      | A `variantId` was sent for a product without variants.                                                     |
| `401`  | `UNAUTHORIZED`           | Missing, malformed, or expired token.                                                                      |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `orders.manage`.                                                                       |
| `404`  | `CUSTOMER_NOT_FOUND`     | `customerId` is not a customer of this store.                                                              |
| `409`  | `STORE_NOT_CONFIGURED`   | The store has no default branch (and no `branchId` was provided).                                          |
| `409`  | `PRODUCT_UNAVAILABLE`    | A cart product is unknown, DRAFT, or deleted for this store.                                               |
| `409`  | `INSUFFICIENT_STOCK`     | A line exceeds the branch's available stock (no write happens).                                            |
| `409`  | `PAYMENT_NOT_CONFIGURED` | `CARD` sale but the store has no Paystack credentials.                                                     |
| `409`  | `ORDER_LIMIT_REACHED`    | The store's subscription is at/over its billing-period order cap.                                          |
| `502`  | `PAYMENT_PROVIDER_ERROR` | `CARD`: provider initiation failed (order left CANCELLED).                                                 |

Uniform error body shape (see `docs/api-contracts/README.md`).