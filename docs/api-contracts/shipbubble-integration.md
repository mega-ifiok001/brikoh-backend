# Shipbubble delivery integration

Shipbubble runs through a Brikoh platform account. API credentials stay in
backend environment secrets. Sandbox is the default; live requests require
`SHIPBUBBLE_MODE=live` and `SHIPBUBBLE_ENABLE_LIVE=true` after operational and
billing arrangements are approved. Configure `SHIPBUBBLE_API_KEY` on the
backend; do not send it from a mobile app.

## Configure a store (dashboard, owner only)

`GET /api/dashboard/settings/shipbubble` returns `{ "configured": false }`
or the saved sender address code, category ID, and package dimensions. It
never returns the platform API key.

`PUT /api/dashboard/settings/shipbubble` validates and saves the store's
pickup address and package defaults:

```json
{
  "sender": {
    "name": "Brikoh Store",
    "email": "store@example.com",
    "phone": "+2348000000000",
    "address": "Pickup street address, Lagos, Nigeria"
  },
  "categoryId": 1,
  "packageDimension": { "length": 20, "width": 15, "height": 10 }
}
```

The category ID must be one supported by the Shipbubble account. Each product
must have `shippingWeightKg` set through product create/update. A
`SHIPBUBBLE` delivery option is created through
`/api/dashboard/settings/delivery-options` with `kind: "DELIVERY"` and
`provider: "SHIPBUBBLE"`.

## Buyer quote and checkout (public)

Before checkout, request current rates:

`POST /api/public/checkout/:subdomain/shipping-rates`

```json
{
  "customer": { "name": "Ada Buyer", "email": "ada@example.com" },
  "items": [{ "productId": "product-uuid", "quantity": 1 }],
  "deliveryOptionId": "delivery-option-uuid",
  "deliveryAddress": "10 Example Street",
  "deliveryCity": "Ikeja",
  "deliveryState": "Lagos",
  "deliveryPhone": "+2348000000000"
}
```

Response `200`:

```json
{
  "quoteId": "quote-uuid",
  "expiresAt": "2026-11-26T12:15:00.000Z",
  "options": [{
    "courierId": "courier-id",
    "serviceCode": "service-code",
    "name": "Courier service",
    "fee": "2500.00",
    "providerFee": "2200.00",
    "currency": "NGN",
    "deliveryEta": "1-2 days"
  }]
}
```

Pass the selected option's `quoteId`, `courierId`, and `serviceCode` as
`shipbubbleQuoteId`, `shipbubbleCourierId`, and `shipbubbleServiceCode` to
`POST /api/public/checkout/:subdomain`. The backend verifies the quote is
unexpired, unused, and matches the current cart and destination. The server
adds the quoted customer fee to the order total. No delivery amount from the
app is trusted. If Shipbubble cannot quote the route, the buyer can select a
manual delivery or pickup option instead.

## Book and cancel (dashboard)

After payment is confirmed and the merchant advances fulfilment to
`PREPARING` using `PATCH /api/dashboard/orders/:orderId/fulfillment`, call:

`POST /api/dashboard/orders/:orderId/shipbubble/book`

This books using the stored Shipbubble quote and changes fulfilment to
`READY_FOR_DISPATCH`. Repeated calls return the existing booking when it has
already succeeded. Unknown network outcomes are held for reconciliation to
avoid accidental duplicate bookings.

Before dispatch, a merchant may call
`POST /api/dashboard/orders/:orderId/shipbubble/cancel`. A successful provider
cancellation marks the Brikoh fulfilment cancelled. The endpoint does not
issue a customer payment refund.

## Provider status callback

Configure this callback URL in Shipbubble:

`POST https://<api-host>/api/webhooks/shipbubble/<SHIPBUBBLE_WEBHOOK_SECRET>`

Set a random secret of at least 32 characters in the backend environment.
The path secret is compared in constant time. Provider callbacks are
deduplicated and update the order's fulfilment event history. Do not expose
the configured callback URL in public app screens.

## Backend environment

- `SHIPBUBBLE_API_KEY`: sandbox key for the platform account.
- `SHIPBUBBLE_MODE=sandbox`: default; use `live` only for approved production.
- `SHIPBUBBLE_ENABLE_LIVE=false`: live requests stay blocked unless explicitly
  enabled after billing and operations decisions.
- `SHIPBUBBLE_WEBHOOK_SECRET`: random callback path secret (32+ characters).

Manual delivery and pickup remain available when the provider is unavailable
or cannot serve a route. Shipbubble charges its platform account separately;
funding, shipping reconciliation, and refund handling must be agreed before
live mode is enabled.
