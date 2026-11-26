# Dashboard order fulfilment

Fulfilment is tracked separately from the payment/order status. Payment
confirmation never marks an order delivered, and fulfilment updates never
change the order total, payment, stock, or settlement records.

Auth: bearer + store, `orders.manage` permission. All order IDs are checked
against the authenticated store.

## GET `/api/dashboard/orders/:orderId/fulfillment`

Returns the current fulfilment status, manual courier information (if any),
tracking details, and the append-only status history.

## PATCH `/api/dashboard/orders/:orderId/fulfillment`

Use this endpoint for merchant-arranged delivery and pickup. Shipbubble
updates are reserved for server-side provider callbacks.

Headers: `Authorization: Bearer <accessToken>`, `Content-Type: application/json`.
`Idempotency-Key` is optional; use a unique random value of 8–200 characters
for a user action that may be retried. Repeating a key for the same order is
a no-op; reusing it for another order returns `409 IDEMPOTENCY_KEY_REUSED`.

```json
{
  "status": "CONFIRMED",
  "courierName": "Ayo's delivery rider",
  "courierPhone": "+2348012345678",
  "shipmentReference": "RIDER-1042",
  "trackingUrl": "https://rider.example/track/RIDER-1042",
  "note": "Rider will collect at 2pm"
}
```

Statuses: `ORDER_RECEIVED → CONFIRMED → PREPARING`, then use
`READY_FOR_DISPATCH → DISPATCHED → DELIVERED` for delivery, or
`READY_FOR_PICKUP → COLLECTED` for pickup. `DELIVERY_FAILED` can return to
`READY_FOR_DISPATCH`; `CANCELLED` is terminal. Invalid transitions and
pickup/delivery mismatches return `409`. The merchant may record courier
details and notes with a transition. Tracking URLs must use HTTPS.

Orders must be payment-confirmed (`order.status = PAID`) before a merchant can
advance fulfilment. An order without a configured delivery/pickup option
cannot use this workflow. `CANCELLED` here is a fulfilment state; it does not
issue a payment refund.

Success: `200`, returns `{ status, provider, courierName, courierPhone,
shipmentReference, trackingUrl, events }`. Each event contains `id`,
`status`, `source`, `note`, `courierName`, `shipmentReference`, and
`createdAt` (UTC ISO-8601). Repeating the current status does not add a
duplicate transition event.

## Existing checkout and merchant settings endpoints

- `GET/POST/PUT/DELETE /api/dashboard/settings/delivery-options[/:optionId]`
  configures manual delivery fees and pickup locations/instructions.
- `GET /api/public/storefront/:subdomain` returns active choices to checkout.
- `POST /api/public/checkout/:subdomain` accepts `deliveryOptionId` and
  delivery address fields; the server reads the fee from the configured
  option and includes it as a separate `delivery.fee` in the order response.
- `GET /api/public/orders/:orderId` returns the customer's payment and
  fulfilment status, timeline, courier, shipment reference, and tracking URL.

Uniform error body shape is documented in `README.md`.
