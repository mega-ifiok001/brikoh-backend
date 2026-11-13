# Dashboard campaigns

Route group: dashboard
Auth: bearer + store (`authenticate` + `resolveTenant`) +
`authorize("marketing.manage")` (owners pass implicitly)
Rate-limited: writes (`POST`, `PUT`, `DELETE`) at `60_000` window /
`60` requests; reads are not rate-limited

Time-boxed storefront promotions. A campaign is a marketing banner the
store's public storefront shows while the campaign is live; it may link
a coupon (a `Discount` with coupon limits — `dashboard-discounts.md`) so
the banner and the code travel together.

A campaign is **live** when `isActive` is true AND now is inside its
validity window (both optional — a campaign with no window is evergreen).

Campaign performance stats (orders attributed per campaign) arrive via
`GET /api/dashboard/campaigns/stats` (below). Campaigns are banners, not
email broadcasts — there is no sent/reach tracking; the stats measure
the coupon's sales lift.

## Campaign model

- `name` — required, 1-100 chars.
- `startsAt` / `endsAt` — optional validity window (UTC). Unset ends are
  open-ended; `endsAt` must be later than `startsAt` when both are set.
- `bannerTitle` / `bannerSubtitle` / `ctaLabel` — optional banner copy
  (1-80 chars each); the storefront renders only the fields that are set.
- `discountId` — optional link to a coupon in the same store. Deleting
  the discount later unlinks the campaign (SetNull) — the banner just
  loses its code.
- `isActive` — a campaign only goes live while active.

## GET /api/dashboard/campaigns

Query parameters (all optional):

- `isActive` — `true` / `false` filter.
- `limit` — `1..100`, default `50`.
- `cursor` — the last `id` of the previous page (uuidv7 ids are
  time-ordered, so `id < cursor` gives the next older page); omitted
  starts at the newest.

Campaigns are returned newest-first (`createdAt` descending). Each item
includes the linked discount's `code` (when linked) so the dashboard can
show which code the banner belongs to.

### Success response

Status: `200`

```json
{
  "items": [
    {
      "id": "019f...",
      "name": "August Clearance",
      "startsAt": "2026-08-20T00:00:00.000Z",
      "endsAt": "2026-09-01T23:59:59.999Z",
      "bannerTitle": "August Clearance",
      "bannerSubtitle": "Up to 20% off everything",
      "ctaLabel": "Shop now",
      "discountId": "019f...",
      "discountCode": "AUGUST20",
      "isActive": true,
      "createdAt": "2026-08-19T10:00:00.000Z",
      "updatedAt": "2026-08-19T10:00:00.000Z"
    }
  ],
  "nextCursor": "019f... | null"
}
```

### Error responses

| Status | Code                 | Condition                         |
| ------ | -------------------- | --------------------------------- |
| `400`  | `VALIDATION_ERROR`   | Malformed query (`limit`, `cursor`, `isActive`). |
| `401`  | `UNAUTHORIZED`       | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `marketing.manage`. |

Uniform error body shape (see `docs/api-contracts/README.md`).

---

## POST /api/dashboard/campaigns

### Request

Body:

```json
{
  "name": "string — required, 1-100",
  "startsAt": "string? — UTC ISO-8601",
  "endsAt": "string? — UTC ISO-8601, later than startsAt when both set",
  "bannerTitle": "string? — 1-80",
  "bannerSubtitle": "string? — 1-80",
  "ctaLabel": "string? — 1-80",
  "discountId": "string? — a discount of this store",
  "isActive": "boolean? — default true"
}
```

### Success response

Status: `201` — the created campaign (list-row shape).

A `campaign.created` entry is appended to the store activity log.

### Error responses

| Status | Code                | Condition                          |
| ------ | ------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`  | Invalid fields (bad type, out-of-range banner copy, malformed window). |
| `401`  | `UNAUTHORIZED`      | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `marketing.manage`. |
| `404`  | `DISCOUNT_NOT_FOUND` | `discountId` does not belong to this store. |
| `429`  | `RATE_LIMITED`      | —                                |

---

## GET /api/dashboard/campaigns/:campaignId

One campaign.

### Success response

Status: `200` — the campaign (list-row shape).

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `marketing.manage`. |
| `404`  | `CAMPAIGN_NOT_FOUND`  | No such campaign in this store.    |

---

## PUT /api/dashboard/campaigns/:campaignId

Updates the campaign. Omitted fields keep their current value; at least
one field is required. `bannerTitle` / `bannerSubtitle` / `ctaLabel` /
`discountId` may be `null` to clear them.

### Request

Body (all optional, at least one):

```json
{
  "name": "string — 1-100",
  "startsAt": "string? — UTC ISO-8601, or null to clear",
  "endsAt": "string? — UTC ISO-8601, later than startsAt when both set, or null to clear",
  "bannerTitle": "string? — 1-80, or null to clear",
  "bannerSubtitle": "string? — 1-80, or null to clear",
  "ctaLabel": "string? — 1-80, or null to clear",
  "discountId": "string? — a discount of this store, or null to clear",
  "isActive": "boolean"
}
```

### Success response

Status: `200` — the updated campaign (list-row shape).

A `campaign.updated` entry is appended to the store activity log.

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Invalid fields or empty body.      |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `marketing.manage`. |
| `404`  | `CAMPAIGN_NOT_FOUND`  | No such campaign in this store.    |
| `404`  | `DISCOUNT_NOT_FOUND`  | The new `discountId` does not belong to this store. |
| `429`  | `RATE_LIMITED`        | —                                |

---

## GET /api/dashboard/campaigns/stats

Rate-limited: no (read-only).

Marketing header summary: how the store's coupon engine is performing,
across all campaigns and coupons. Every stat is computed live from
`CouponRedemption` rows and successful orders (`PAID`/`SHIPPED`);
campaigns are banners, not broadcasts — there is no sent/reach tracking.

### Success response

Status: `200`

```json
{
  "totalCampaigns": 3,
  "activeCampaigns": 1,
  "activeCoupons": 2,
  "totalRedemptions": 14,
  "campaigns": [
    {
      "id": "019f...",
      "name": "Independence Week",
      "discountCode": "INDEPENDENCE10",
      "redemptions": 14,
      "attributedOrders": 12,
      "attributedRevenue": "18500.00"
    },
    {
      "id": "019f...",
      "name": "No Code Banner",
      "discountCode": null,
      "redemptions": 0,
      "attributedOrders": 0,
      "attributedRevenue": "0.00"
    }
  ]
}
```

- `totalCampaigns` — campaigns in the store (all statuses).
- `activeCampaigns` — campaigns currently live: `isActive` AND inside
  their validity window (a window-less campaign is always in-window).
- `activeCoupons` — discounts with coupon rules that are `isActive` and
  inside their own validity window.
- `totalRedemptions` — coupon redemption rows across the store.
- `campaigns` — every campaign (newest first), with its linked coupon's
  `discountCode` when linked (`null` otherwise) and the coupon's
  performance: `redemptions` (redemption rows), `attributedOrders`
  (successful orders that redeemed the coupon — the redemption's order
  is `PAID`/`SHIPPED`), and `attributedRevenue` (sum of those orders'
  totals). A campaign without a linked coupon carries zeros.

| Status | Code                 | Condition                         |
| ------ | -------------------- | --------------------------------- |
| `401`  | `UNAUTHORIZED`       | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `marketing.manage`. |

---

## DELETE /api/dashboard/campaigns/:campaignId

Deletes the campaign. The linked discount (and its redemption history)
is untouched.

### Success response

Status: `200`

```json
{ "ok": true }
```

A `campaign.deleted` entry is appended to the store activity log.

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `marketing.manage`. |
| `404`  | `CAMPAIGN_NOT_FOUND`  | No such campaign in this store.    |
| `429`  | `RATE_LIMITED`        | —                                |

Uniform error body shape (see `docs/api-contracts/README.md`).