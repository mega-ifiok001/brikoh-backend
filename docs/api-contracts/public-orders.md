# Public order API — `/api/public/orders`

Route group: public
Auth: none (keyed by the order's public UUID, never the `orderNumber`)
Rate-limited: `mark-paid` only (`60_000` window / `20` requests). The read
endpoint is not independently rate-limited.

These endpoints let a storefront buyer track a bank-transfer order and signal
"I have paid". They are the public, read-only counterpart to the merchant
confirm/reject actions in `dashboard-orders.md`.

## GET /api/public/orders/:orderId

Returns the buyer-facing order status and — for bank-transfer orders — the
**frozen** merchant bank details captured at checkout. The live `BankAccount`
row is never read, so editing or deleting the merchant's account cannot
misdirect an in-flight payment.

### Success response — `200`

```json
{
  "id": "string — the order's public UUID (the path param)",
  "status": "PENDING | AWAITING_PAYMENT | PAID | SHIPPED | CANCELLED | REFUNDED | FAILED",
  "fulfillment": {
    "status": "ORDER_RECEIVED | CONFIRMED | PREPARING | READY_FOR_DISPATCH | DISPATCHED | DELIVERED | DELIVERY_FAILED | READY_FOR_PICKUP | COLLECTED | CANCELLED",
    "courierName": "string | null",
    "shipmentReference": "string | null",
    "trackingUrl": "https://... | null",
    "events": [{ "status": "CONFIRMED", "createdAt": "UTC ISO-8601" }]
  },
  "paymentProvider": "bank_transfer",
  "paymentReference": "BRK-XXXXXXXXXX",
  "bankDetails": {
    "bankName": "Access Bank",
    "accountName": "Adebayo Idowu",
    "accountNumber": "0123456789",
    "reference": "BRK-XXXXXXXXXX"
  },
  "delivery": {
    "kind": "DELIVERY",
    "optionName": "Delivery Rider",
    "address": "12 Admiralty Way, Lekki",
    "city": "Lagos",
    "state": "Lagos",
    "phone": "08012345678",
    "instructions": "Call on arrival",
    "fee": "2000.00"
  }
}
```

For non-bank-transfer orders `paymentProvider` is `"paystack"` and
`bankDetails` is `null`.

`delivery` is the **frozen** snapshot captured at checkout
(`dashboard-delivery-options.md`): the chosen option name, the customer's
address (null for a `PICKUP` option), and the fee — never the live option
row, so editing or deleting an option cannot change a placed order. It is
`null` for orders with no delivery option (e.g. orders created before the
feature).

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `404`  | `ORDER_NOT_FOUND` | No order with that id |

## POST /api/public/orders/:orderId/mark-paid

Buyer clicks "I have paid". Atomically moves `PENDING → AWAITING_PAYMENT`
and stamps `paymentSubmittedAt`, then fires the `PAYMENT_CLAIMED` merchant
alert (`dashboard-notifications.md`). Idempotent: a repeat click on an
already-`AWAITING_PAYMENT` order returns its current state instead of
erroring. A merchant confirm/reject later drives the order to `PAID` or back
to `PENDING` (`dashboard-orders.md`).

### Success response — `200`

The same `PublicOrderView` as `GET` above, now with `status: "AWAITING_PAYMENT"`.

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `404`  | `ORDER_NOT_FOUND` | No order with that id |
| `409`  | `INVALID_PAYMENT_METHOD` | The order was not placed via `bank_transfer` |
| `409`  | `ORDER_ALREADY_PAID` | The order is already `PAID` |
| `409`  | `ORDER_NOT_PENDING` | The order is in a state that can't be claimed (e.g. `SHIPPED`, `CANCELLED`) |
| `429`  | `RATE_LIMITED` | Too many requests |

## Auto-expiry

An `AWAITING_PAYMENT` order whose claim is older than the configured max age
(default `12h`, configurable via `EXPIRY_SWEEP_MAX_AGE_MS`) is automatically
reclaimed to `PENDING` by a server-side sweep, so a merchant's queue can't
fill with stale or false claims. The reclaim and a concurrent merchant
confirm are mutually exclusive (both guard on `status: "AWAITING_PAYMENT"),
so exactly one transition ever applies.
