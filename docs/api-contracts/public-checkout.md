# POST /api/public/checkout/:subdomain

Route group: public
Auth: none (the store's subdomain is the tenant address; payment credentials live on the server)
Rate-limited: yes (touches payment data — RULES.md security baseline)

## Request

Headers:
- `Content-Type: application/json`

Path params:
- `subdomain: string — the store's unique subdomain (case-insensitive, normalized server-side)`

Body:

```json
{
  "customer": {
    "name": "string — required, 1-200 chars",
    "email": "string — required, valid email",
    "phone": "string? — optional, 1-30 chars"
  },
  "items": [
    {
      "productId": "string — required",
      "variantId": "string — optional; REQUIRED when the product has variants",
      "quantity": "integer — required, 1-9999"
    }
  ],
  "discountCode": "string? — optional; an active, in-window discount code of the store (`dashboard-discounts.md`)",
  "origin": "\"DIRECT\" | \"SOCIAL\" | \"MARKETPLACE\" | \"REFERRAL\"? — optional; how the buyer reached the storefront",
  "paymentMethod": "\"paystack\" | \"bank_transfer\"? — optional; defaults to \"paystack\"",
  "deliveryOptionId": "string? — the chosen delivery option (`dashboard-delivery-options.md`); REQUIRED when the store has any active option",
  "deliveryAddress": "string? — the customer's street address; REQUIRED for a DELIVERY-kind option, 1-500 chars",
  "deliveryCity": "string? — REQUIRED for a DELIVERY-kind option, 1-120 chars",
  "deliveryState": "string? — REQUIRED for a DELIVERY-kind option, 1-120 chars",
  "deliveryPhone": "string? — REQUIRED for a DELIVERY-kind option, 1-30 chars",
  "deliveryInstructions": "string? — optional delivery instructions, up to 500 chars"
}
```

Notes:
- `items` must contain at least 1 and at most 50 entries.
- Prices are NEVER client-supplied. The server reads each product's current
  price and records it as `unitPriceAtPurchase`; `order.total` is computed
  server-side as the sum of price × quantity. Variant lines price at the
  variant's `sellingPrice` when set, falling back to the product price.
- A product that has variants MUST be carted per-variant (`variantId` on
  every line): carting it bare is rejected with `400 VARIANT_REQUIRED`, and
  a `variantId` on a variant-less product is `400 VARIANT_NOT_FOUND`. A
  `variantId` that does not exist (or belongs to another product) is
  `409 PRODUCT_UNAVAILABLE`; stock checks read the VARIANT's quantity.
  Different variants of the same product stay separate line items.
- **Branch resolution**: the order draws its stock from the store's default
  branch (resolved server-side from `Store.defaultBranchId`; a store
  without a default branch cannot sell — `409 STORE_NOT_CONFIGURED`). The
  branch is pinned on the order at initiation and cannot be changed by the
  buyer.
- **Overselling is never allowed.** There is no merchant override: if any
  line's quantity exceeds the branch's current stock, checkout is rejected
  with `409 INSUFFICIENT_STOCK` BEFORE any payment is attempted, and the
  payment-confirmation webhook applies the same guarded decrement, so a
  concurrent sale can never push the branch's stock below zero.
- If a matching Customer (by store + lowercase email) already exists, it is
  reused; otherwise one is created.
- **Discounts**: an optional `discountCode` applies a cart-wide discount
  computed server-side (`dashboard-discounts.md`); it only applies when
  active and inside its validity window, and never exceeds the line
  total. The discount is captured on the order as `discountAmount` (with
  `discountId`). Checkout applies no group discounts — storefront buyers
  are anonymous.
- **Origin**: an optional `origin` attribute-tags the order's channel.
  It maps directly onto `OrderSource`: `DIRECT | SOCIAL | MARKETPLACE |
  REFERRAL`. Omitted it defaults to `STOREFRONT`; present with any
  other value it is rejected with `400 VALIDATION_ERROR`. The tag
  powers the revenue-by-channel breakdown (`analytics-api.md`).
- The charge currency is the store's profile currency (set during
  onboarding): `NGN | USD | GHS | KES | ZAR`. It is never client-supplied.
  All supported currencies use a 2-decimal minor unit (kobo/pesewa/cent),
  so the server's ×100 amount conversion is exact for every one of them.
- **Delivery**: the buyer picks one of the store's active delivery options
  (`dashboard-delivery-options.md`). When the store has at least one active
  option, `deliveryOptionId` is **required** (`409 DELIVERY_OPTION_REQUIRED`);
  it must be an active option of the store (`404 DELIVERY_OPTION_NOT_FOUND`).
  For a `DELIVERY`-kind option, `deliveryAddress`, `deliveryCity`,
  `deliveryState`, and `deliveryPhone` are all required (missing any →
  `400 DELIVERY_DETAILS_REQUIRED`); `deliveryInstructions` is optional. A
  `PICKUP` option needs none of these — its location lives on the option
  itself. The **fee** is the option's own `baseFee`, read from the database
  server-side (a client-supplied fee is never trusted) and added to the
  order total; the option name, fee, and address are frozen on the order.
  `order.total` = line items − discount + delivery fee.
- **Payment method selection** (`paymentMethod`, defaults to `"paystack"`):
  - `"paystack"` — the default. A provider charge is initiated and the
    response returns a `redirectUrl` to the hosted checkout. The order
    becomes `PAID` only on webhook confirmation.
  - `"bank_transfer"` — no provider call is made. The store's **default
    merchant bank account** is snapshotted onto the order (frozen at
    initiation, so later edits to the account don't change a placed order),
    and the response returns `payment.bankDetails` plus a `BRK-`-prefixed
    `payment.reference` the buyer quotes when paying. The order is left in
    `PENDING` and the buyer later signals payment via
    `POST /api/public/orders/:orderId/mark-paid` (`public-orders.md`);
    the merchant confirms/rejects from the dashboard
    (`dashboard-orders.md`). The storefront advertises which methods are
    actually usable via `availablePaymentMethods` on
    `GET /api/public/storefront/:subdomain` (`public-storefront.md`) —
    `bank_transfer` only appears there when a default account exists.
  - A `bank_transfer` checkout with no default merchant bank account is
    rejected with `409 BANK_ACCOUNT_NOT_CONFIGURED`.

## Success response

Status: `200`

```json
{
  "order": {
    "id": "string",
    "orderNumber": "ORD-0007 — store-sequential, assigned at initiation",
    "total": "1234.56 — decimal, server-computed, minus any discount plus the delivery fee",
    "status": "PENDING"
  },
  "payment": {
    "provider": "paystack",
    "reference": "string — provider-facing reference",
    "redirectUrl": "string — hosted checkout URL to redirect the buyer to"
  }
}
```

For `"bank_transfer"` the `payment` object instead looks like:

```json
{
  "payment": {
    "provider": "bank_transfer",
    "reference": "BRK-XXXXXXXXXX — 10 base36 chars; the buyer quotes this when paying",
    "redirectUrl": "",
    "bankDetails": {
      "bankName": "Access Bank",
      "accountName": "Adebayo Idowu",
      "accountNumber": "0123456789",
      "reference": "BRK-XXXXXXXXXX"
    }
  }
}
```

Notes:
- The Order is PENDING and stock is NOT decremented at this point. Stock
  movement and the PAID transition happen only on webhook confirmation
  (Phase 9) for `paystack`, or on merchant confirmation for `bank_transfer`
  (`dashboard-orders.md`).
- The payment reference travels in this response AND in the redirect flow;
  it identifies the order for later webhook reconciliation.
- For `bank_transfer` there is no `redirectUrl` (empty string); the buyer
  pays the merchant directly and then calls `mark-paid`.

## Error responses

| Status | Condition |
| ------ | --------- |
| `400`  | Invalid input (empty cart, bad email, bad quantity) |
| `400`  | `VARIANT_REQUIRED` — a variant product was carted without `variantId` |
| `400`  | `VARIANT_NOT_FOUND` — `variantId` given for a product that has no variants |
| `404`  | `STORE_NOT_FOUND` — no store with that subdomain |
| `409`  | `STORE_NOT_CONFIGURED` — the store has no default branch |
| `409`  | `PRODUCT_UNAVAILABLE` — an item is missing, deleted, or names an unknown/foreign variant |
| `409`  | `INSUFFICIENT_STOCK` — an item's quantity exceeds the default branch's current stock (checked BEFORE any payment is attempted; overselling is never allowed, no merchant override exists) |
| `400`  | `DISCOUNT_UNAVAILABLE` — the `discountCode` is not active or is outside its validity window |
| `404`  | `DISCOUNT_NOT_FOUND` — the `discountCode` is not a discount of this store |
| `409`  | `DELIVERY_OPTION_REQUIRED` — the store has active delivery options but none was chosen |
| `404`  | `DELIVERY_OPTION_NOT_FOUND` — `deliveryOptionId` is unknown, inactive, or another store's |
| `400`  | `DELIVERY_DETAILS_REQUIRED` — a `DELIVERY`-kind option was chosen but address, city, state, or phone is missing |
| `409`  | `PAYMENT_NOT_CONFIGURED` — the store has no payment credentials saved |
| `409`  | `BANK_ACCOUNT_NOT_CONFIGURED` — `paymentMethod: "bank_transfer"` but the store has no default merchant bank account |
| `502`  | `PAYMENT_PROVIDER_ERROR` — the provider rejected or failed the initiation; the created Order was marked `CANCELLED`, nothing is left dangling |
| `429`  | Rate limited |

Error body shape (uniform across the API):

```json
{
  "error": {
    "code": "string",
    "message": "string"
  }
}
```
