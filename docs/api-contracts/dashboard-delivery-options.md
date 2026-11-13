# Dashboard delivery options (storefront checkout)

Routes:

- `GET /api/dashboard/settings/delivery-options`
- `POST /api/dashboard/settings/delivery-options`
- `PUT /api/dashboard/settings/delivery-options/:optionId`
- `DELETE /api/dashboard/settings/delivery-options/:optionId`

Route group: dashboard

Auth:

- Bearer + store (`resolveTenant`)
- Owner-only (`requireOwner`) — staff are rejected regardless of role
- Rate-limited: the settings group limit (`300`/60s) plus a per-route write limit of `60`/min

The merchant-configured **fulfilment choices** the storefront buyer picks at
checkout — "Pick up at store", "Delivery Rider — ₦2,000", etc. Each option
has a **kind** (`PICKUP` or `DELIVERY`), a flat **base fee**, and an optional
pickup location. The buyer's delivery fee is simply the option's `baseFee`,
read from the database at checkout — a client-supplied fee is never trusted.

Phase 1 is deliberately flat: **no zones, zone fees, distance pricing, maps,
or logistics integration**. The shape leaves room for a richer pricing model
later.

The storefront advertises the active options via
`GET /api/public/storefront/:subdomain` (`public-storefront.md`) and the
buyer selects one at checkout (`public-checkout.md`). When a store has at
least one active option, checkout **requires** a selection; a `DELIVERY`
option additionally requires the customer's address, city, state, and phone.

## Option shape

```json
{
  "id": "string — uuid (v7)",
  "name": "string — 1-200 chars, unique per store, e.g. \"Delivery Rider\"",
  "kind": "\"PICKUP\" | \"DELIVERY\"",
  "description": "string | null — up to 500 chars, e.g. \"Same-day rider\"",
  "baseFee": "string — 2dp decimal, >= 0 (the flat fee charged)",
  "isActive": "boolean — false hides it from the storefront checkout",
  "sortOrder": "number — integer, display order",
  "pickupLocationId": "string | null — a store Location reused for PICKUP pickup details",
  "pickupAddressText": "string | null — free-text pickup address (up to 500 chars)",
  "pickupLocation": "{ id, name, address } | null — the resolved Location",
  "createdAt": "string — UTC ISO-8601",
  "updatedAt": "string — UTC ISO-8601"
}
```

- `pickupLocationId` and `pickupAddressText` are independent — a pickup option
  may reference a store `Location`, carry free text, or both. Both are
  `null` for delivery options; the customer's own address is collected at
  checkout, not configured here.
- Deleting an option never rewrites order history: each order freezes the
  option name, the fee, and the delivery address at checkout.

## GET /api/dashboard/settings/delivery-options

Lists the store's options, `sortOrder` then `createdAt` ascending.

### Success response — `200`

```json
{ "deliveryOptions": ["Option shape"] }
```

## POST /api/dashboard/settings/delivery-options

### Request body

```json
{
  "name": "Delivery Rider",
  "kind": "DELIVERY",
  "description": "Same-day rider",
  "baseFee": "2000",
  "isActive": true,
  "sortOrder": 0,
  "pickupLocationId": null,
  "pickupAddressText": null
}
```

- `name` — `1..200` chars, trimmed, unique per store (`409 DELIVERY_OPTION_EXISTS` on a collision).
- `kind` — required, `PICKUP` or `DELIVERY`.
- `baseFee` — number or decimal string, `>= 0`, max `99999999.99`, at most 2dp; defaults to `0`.
- `isActive` — optional, defaults `true`.

### Success response — `201` — the Option shape.

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `400`  | `VALIDATION_ERROR` | Missing/invalid `name`/`kind`/`baseFee` |
| `401`  | `UNAUTHORIZED` | Missing/invalid token |
| `403`  | `ACCESS_DENIED` | Authenticated staff (owner only) |
| `404`  | `NOT_FOUND` | `pickupLocationId` names a location outside the store |
| `409`  | `DELIVERY_OPTION_EXISTS` | Another option already uses that `name` |

## PUT /api/dashboard/settings/delivery-options/:optionId

Partial update — supplied fields change, absent fields are unchanged.

### Success response — `200` — the Option shape.

### Error responses

Same as POST, plus `404 NOT_FOUND` for an unknown / cross-tenant option id.

## DELETE /api/dashboard/settings/delivery-options/:optionId

Hard-deletes the option. Past orders are unaffected — they keep the frozen
`deliveryOptionName` / `deliveryFee` / address snapshot. Idempotent: deleting
an already-deleted option returns `204`.

### Success response — `204`

### Error responses

| Status | Code | Condition |
| ------ | ---- | --------- |
| `401`  | `UNAUTHORIZED` | Missing/invalid token |
| `403`  | `ACCESS_DENIED` | Authenticated staff (owner only) |
| `404`  | `NOT_FOUND` | Unknown / cross-tenant option id |

Uniform error body shape (see `docs/api-contracts/README.md`).
