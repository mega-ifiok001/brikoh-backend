# Dashboard discounts

Route group: dashboard
Auth: bearer + store (`authenticate` + `resolveTenant`) +
`authorize("discounts.manage")` (owners pass implicitly)
Rate-limited: writes (`POST`, `PUT`, `DELETE`) at `60_000` window /
`60` requests; reads are not rate-limited

Reusable cart-wide discounts a store can define and apply at sale time.
A discount is either:

- **attached to a customer group** (`dashboard-customer-groups.md`) and
  auto-applied when that group's member buys at the POS, or
- **applied explicitly** at the POS (by id) or at storefront checkout
  (by code).

Money values are decimal strings. All timestamps are UTC ISO-8601.

## Discount model

- `type` — `PERCENTAGE` (percent of the pre-discount line total) or
  `FIXED` (a flat amount off the cart).
- `value` — the percentage (`0 < value <= 100`) or the fixed amount
  (`0 < value <= 99999999.99`).
- `code` — optional, unique per store (case-insensitive, normalized to
  uppercase server-side); used at storefront checkout.
- `startsAt` / `endsAt` — optional validity window (UTC). Unset ends are
  open-ended; `endsAt` must be later than `startsAt` when both are set.
- `isActive` — a discount only applies while active.
- A discount always applies cart-wide; there is no per-product scope.

## Coupon limits

A discount with a `code` becomes a **coupon** when it carries any of the
coupon limits below. Coupons are enforced at sale time (POS and
storefront checkout) and every successful use writes a `CouponRedemption`
row against the order — the redemption history powers campaign stats
later. A discount without these fields behaves exactly as before (no
redemptions are recorded).

- `maxUses` — optional global cap on total redemptions.
- `perCustomerUses` — optional cap per customer; default `1`.
- `minSubtotal` — optional minimum pre-discount line total for the code
  to apply (decimal string, `> 0`).
- `firstOrderOnly` — optional: the code only applies to a customer with
  no previous orders in the store.
- A coupon code is case-insensitive (normalized to uppercase
  server-side) and unique per store, like any discount code.

### Coupon enforcement at sale time

Checks run server-side inside the same transaction that creates the
order (POS record-sale and storefront checkout alike):

| Condition                        | Error                  |
| -------------------------------- | ---------------------- |
| Redemptions reached `maxUses`    | `COUPON_EXHAUSTED`     |
| Customer reached `perCustomerUses` | `COUPON_ALREADY_USED` |
| Line total below `minSubtotal`   | `COUPON_MIN_SUBTOTAL`  |
| Customer has prior orders but `firstOrderOnly` is set | `COUPON_FIRST_ORDER_ONLY` |

Group auto-applied discounts (customer groups) never record redemptions
and never fail sales — they are rules, not codes.

## Applying a discount

- The **discount amount is computed server-side** — clients never send a
  money amount for a managed discount.
  - `PERCENTAGE`: `amount = round(lineTotal * value / 100)` (2 dp,
    half-up).
  - `FIXED`: `amount = value`.
- A discount can never exceed the pre-discount line total: `amount` is
  capped at `lineTotal` (`FIXED` larger than the cart is not an error at
  sale time — it simply zeroes the total; explicit validation errors are
  listed per-endpoint below).
- The applied discount is captured on the Order as `discountAmount` with
  `discountId` recording which rule was used. Deleting a discount later
  never rewrites captured orders (SetNull semantics) — the money facts
  live on the order.
- A discount only applies if it is `isActive` **and** within its validity
  window (when set).

## GET /api/dashboard/discounts

Query parameters (all optional):

- `isActive` — `true` / `false` filter.
- `type` — filter by `PERCENTAGE | FIXED`.
- `limit` — `1..100`, default `50`.
- `cursor` — the last `id` of the previous page (uuidv7 ids are
  time-ordered, so `id < cursor` gives the next older page); omitted
  starts at the newest.

Discounts are returned newest-first (`createdAt` descending).

### Success response

Status: `200`

```json
{
  "items": [
    {
      "id": "019f...",
      "name": "VIP 10%",
      "type": "PERCENTAGE",
      "value": "10.00",
      "code": null,
      "startsAt": null,
      "endsAt": null,
      "isActive": true,
      "createdAt": "2026-08-01T10:00:00.000Z",
      "updatedAt": "2026-08-01T10:00:00.000Z"
    }
  ],
  "nextCursor": "019f... | null"
}
```

### Error responses

| Status | Code                 | Condition                         |
| ------ | -------------------- | --------------------------------- |
| `400`  | `VALIDATION_ERROR`   | Malformed query (`limit`, `cursor`, `isActive`, `type`). |
| `401`  | `UNAUTHORIZED`       | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `discounts.manage`. |

Uniform error body shape (see `docs/api-contracts/README.md`).

---

## POST /api/dashboard/discounts

### Request

Body:

```json
{
  "name": "string — required, 1-100",
  "type": "PERCENTAGE | FIXED — required",
  "value": "string — required, > 0, at most 2 decimal places (max 100 for PERCENTAGE, 99999999.99 for FIXED)",
  "code": "string — optional, 3-40 chars, alphanumeric and dashes, unique per store (case-insensitive)",
  "startsAt": "string? — UTC ISO-8601",
  "endsAt": "string? — UTC ISO-8601, later than startsAt when both set",
  "isActive": "boolean? — default true",
  "maxUses": "integer? — > 0, global redemption cap (coupon)",
  "perCustomerUses": "integer? — > 0, cap per customer (coupon, default 1)",
  "minSubtotal": "string? — > 0, at most 2 decimal places (coupon)",
  "firstOrderOnly": "boolean? — only first-time customers (coupon)"
}
```

### Success response

Status: `201` — the created discount (list-row shape).

A `discount.created` entry is appended to the store activity log.

### Error responses

| Status | Code                | Condition                          |
| ------ | ------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`  | Invalid fields (bad type, out-of-range value, malformed window, conflicting coupon limits). |
| `401`  | `UNAUTHORIZED`      | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `discounts.manage`. |
| `409`  | `DISCOUNT_CODE_TAKEN` | `code` already belongs to another discount in the store. |
| `429`  | `RATE_LIMITED`      | —                                |

---

## GET /api/dashboard/discounts/:discountId

One discount.

### Success response

Status: `200` — the discount (list-row shape).

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `discounts.manage`. |
| `404`  | `DISCOUNT_NOT_FOUND`  | No such discount in this store.    |

---

## PUT /api/dashboard/discounts/:discountId

Updates the discount. Omitted fields keep their current value; at least
one field is required.

### Request

Body (all optional, at least one):

```json
{
  "name": "string — 1-100",
  "type": "PERCENTAGE | FIXED",
  "value": "string — > 0, at most 2 decimal places (bounds per type)",
  "code": "string — 3-40 chars, unique per store (case-insensitive), or null to clear",
  "startsAt": "string? — UTC ISO-8601, or null to clear",
  "endsAt": "string? — UTC ISO-8601, later than startsAt when both set, or null to clear",
  "isActive": "boolean",
  "maxUses": "integer? — > 0, or null to clear (coupon)",
  "perCustomerUses": "integer? — > 0, or null to clear (coupon, default 1)",
  "minSubtotal": "string? — > 0, at most 2 decimal places, or null to clear (coupon)",
  "firstOrderOnly": "boolean? (coupon)"
}
```

### Success response

Status: `200` — the updated discount (list-row shape).

A `discount.updated` entry is appended to the store activity log.

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Invalid fields or empty body.      |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `discounts.manage`. |
| `404`  | `DISCOUNT_NOT_FOUND`  | No such discount in this store.    |
| `409`  | `DISCOUNT_CODE_TAKEN` | The new code already belongs to another discount. |
| `429`  | `RATE_LIMITED`        | —                                |

---

## DELETE /api/dashboard/discounts/:discountId

Deletes the discount. Existing orders and customer groups that referenced
it are not blocked: captured order money (`discountAmount`) is untouched,
and affected groups simply lose their auto-applied discount (SetNull).
Coupon redemption history dies with the discount (Cascade) — redemptions
are usage accounting, not financial records; captured order money
survives either way.

### Success response

Status: `200`

```json
{ "ok": true }
```

A `discount.deleted` entry is appended to the store activity log.

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `discounts.manage`. |
| `404`  | `DISCOUNT_NOT_FOUND`  | No such discount in this store.    |
| `429`  | `RATE_LIMITED`        | —                                |

Uniform error body shape (see `docs/api-contracts/README.md`).
