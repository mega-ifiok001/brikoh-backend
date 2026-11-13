# GET /api/public/storefront/:subdomain

Route group: public
Auth: none (the storefront is a public page; its address IS the credential)
Rate-limited: yes (`60_000` window / `300` requests, same as checkout)

Returns what a storefront page needs to render: the store's name and
its storefront settings (template, hero copy, accent color, WhatsApp
button, social links, badge toggle). This is the public read of the
settings the owner edits via `GET/PUT /api/dashboard/settings/storefront`
(`dashboard-settings.md`).

When the store has a **live campaign** (`dashboard-campaigns.md`), the
response also carries the campaign banner: the first campaign that is
active, inside its validity window (evergreen campaigns — no window —
count as always inside), ordered newest-first. `campaign` is `null`
when there is no live campaign; the banner renders only the copy fields
that are set.

The public projection is deliberately narrow: business phone, location,
currency and every other tenant resource never appear here.

## Request

Path params:

- `subdomain: string — the store's subdomain (normalized to lowercase; unknown subdomains are a 404)`

No headers, query, or body parameters.

## Success response

Status: `200`

```json
{
  "storeName": "Fresh Mart",
  "subdomain": "fresh-mart",
  "template": "CLASSIC",
  "tagline": null,
  "heroTitle": null,
  "heroSubtitle": null,
  "accentColor": "#18181b",
  "whatsappButtonEnabled": false,
  "whatsappNumber": null,
  "showPoweredByBadge": true,
  "ga4MeasurementId": null,
  "socialLinks": {
    "instagram": null,
    "facebook": null,
    "tiktok": null
  },
  "campaign": {
    "bannerTitle": "August Clearance",
    "bannerSubtitle": "Up to 20% off everything",
    "ctaLabel": "Shop now"
  },
  "availablePaymentMethods": ["paystack", "bank_transfer"],
  "deliveryOptions": [
    {
      "id": "opt_01...",
      "name": "Pick up at store",
      "kind": "PICKUP",
      "description": "Mon-Fri, 10am-4pm",
      "baseFee": "0"
    },
    {
      "id": "opt_02...",
      "name": "Delivery Rider",
      "kind": "DELIVERY",
      "description": "Same-day rider",
      "baseFee": "2000"
    }
  ]
}
```

`campaign` is `null` when no campaign is live. The banner copy fields
are the ones set on the campaign; unset ones are omitted.

`availablePaymentMethods` is the derived list of checkout payment methods
the store can actually accept, so the storefront UI can hide an option
**before** the buyer hits a dead-end error:

- `"paystack"` is present when the store has a saved Paystack credential.
- `"bank_transfer"` is present only when the store has a **default merchant
  bank account** with a real account number.

An empty array means the store has configured nothing yet. It is computed
at read time and never stored.

`deliveryOptions` is the store's active fulfilment choices, in `sortOrder`
(see `dashboard-delivery-options.md`). The buyer picks one at checkout
(`public-checkout.md`); when at least one is present a selection is
required. `kind` is `PICKUP` or `DELIVERY`; the delivery fee is the option's
own `baseFee` (a decimal string) — no zones or distance pricing in Phase 1.
A `DELIVERY` option additionally requires the buyer to enter their address at
checkout.

Unset settings fall back to the same defaults as the dashboard read
(see `dashboard-settings.md`).

## Error responses

| Status | Code               | Condition                         |
| ------ | ------------------ | --------------------------------- |
| `400`  | `VALIDATION_ERROR` | Missing subdomain                 |
| `404`  | `STORE_NOT_FOUND`  | No store exists at that subdomain |
| `429`  | `RATE_LIMITED`     | —                                 |

---

# GET /api/public/storefront/:subdomain/products

Route group: public
Auth: none
Rate-limited: yes (same `60_000` / `300` as the rest of the public storefront group)

Lists the store's **published** products for the customer-facing catalog
(the store front page / product grid). Only products with
`status: PUBLISHED` and not soft-deleted are returned — DRAFT, deleted,
and other stores' products are never visible. Results are ordered newest
first and cursor-paginated.

Stock is shown as a coarse status, never a raw number:

- `IN_STOCK`
- `LOW_STOCK`
- `OUT_OF_STOCK`

The "low" threshold is reused from the product's `lowStockThreshold`
(the Inventory Dashboard's "alert at N" reorder point) — a single source
of truth for what "low" means. Variant products report a per-variant
status plus an aggregated product-level status (a product is
`OUT_OF_STOCK` only when every variant is sold out; `LOW_STOCK` when at
least one variant is at or below threshold).

**Archived variants are hidden.** A variant retired from the dashboard
(`archivedAt` set) never appears in `variants` and never counts toward the
product-level stock status. A product whose variants are ALL archived is
treated as having no available options.

A published product at zero stock is **still returned** (as
`OUT_OF_STOCK`) so it stays discoverable for when it is restocked — the
filter is `status: PUBLISHED` only, with no stock condition.

## Request

Path params:

- `subdomain: string` — the store's subdomain.

Query params (all optional):

- `limit: number` (1–200, default 50) — page size.
- `cursor: string` (uuid) — opaque page cursor from a previous
  `nextCursor`. A malformed value is a `400`.
- `categoryId: string` (uuid) — restrict to a category. This is a
  **filter**, not a resource: an unknown or other-store id returns an
  empty `200`, never a `404`. A malformed value is a `400`.
- `q: string` — case-insensitive substring match on the product **name
  only** (not description).

## Success response

Status: `200`

```json
{
  "items": [
    {
      "id": "prod_01H...",
      "name": "Beaded Clutch",
      "description": "Hand-beaded evening clutch.",
      "price": "12000.00",
      "discountPrice": null,
      "coverImageUrl": "https://cdn.example.com/cover.jpg",
      "images": ["https://cdn.example.com/1.jpg"],
      "category": { "id": "cat_01...", "name": "Bags" },
      "unit": { "id": "unit_01...", "name": "Piece" },
      "options": [
        { "name": "Colour", "values": ["Red", "Blue"] },
        { "name": "Size", "values": ["S", "M"] }
      ],
      "variants": [
        {
          "id": "var_01...",
          "name": "Red / S",
          "sellingPrice": "9000.00",
          "stockStatus": "LOW_STOCK",
          "options": [
            { "name": "Colour", "value": "Red" },
            { "name": "Size", "value": "S" }
          ]
        }
      ],
      "stockStatus": "LOW_STOCK"
    }
  ],
  "nextCursor": "prod_01H...",
  "total": 42
}
```

- `price` / `discountPrice` / variant `sellingPrice` are strings (always
  2dp). `discountPrice` and `sellingPrice` are `null` when unset; a
  variant with `sellingPrice: null` falls back to the product `price`.
- `options` — the product's variant dimensions and their selectable
  values (merchant-defined, free text; max 2 dimensions). `variants[].options`
  names the value this variant corresponds to for each dimension. Absent
  dimensions are `[]`.
- `coverImageUrl` / `unit` / `category` may be `null`.
- `nextCursor` is `null` on the last page.
- `total` is the full count (ignoring pagination).

When the result set is **empty**, the response is still `200` with
`items: []` and a human-readable `message` describing why:

| Situation                                 | `message`                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| Store has no published products           | `"This store hasn't published any products yet."`                          |
| `categoryId` matched nothing              | `"There are no products in this category yet."`                            |
| `q` matched nothing                       | `"No products match \"<term>\". Try a different spelling or search term."` |
| both `q` and `categoryId` matched nothing | `"No products match your search in this category."`                        |

`message` is absent when items are returned.

## Error responses

| Status | Code               | Condition                                                               |
| ------ | ------------------ | ----------------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR` | `limit` out of range, or malformed `cursor` / `categoryId` (not a uuid) |
| `404`  | `STORE_NOT_FOUND`  | No store exists at that subdomain                                       |
| `429`  | `RATE_LIMITED`     | —                                                                       |

---

# GET /api/public/storefront/:subdomain/products/:productId

Route group: public
Auth: none
Rate-limited: yes (same bucket)

Single published product for the customer-facing detail page (e.g. a
shared WhatsApp / Instagram product link). Returns the same item shape as
the list endpoint. Unknown, cross-tenant, soft-deleted, or DRAFT products
are indistinguishable and return `404`.

## Request

Path params:

- `subdomain: string`
- `productId: string` (uuid) — the product id.

## Success response

Status: `200` — a single product object (the `items[0]` shape above),
e.g.:

```json
{
  "id": "prod_01H...",
  "name": "Beaded Clutch",
  "description": "Hand-beaded evening clutch.",
  "price": "12000.00",
  "discountPrice": null,
  "coverImageUrl": "https://cdn.example.com/cover.jpg",
  "images": ["https://cdn.example.com/1.jpg"],
  "category": { "id": "cat_01...", "name": "Bags" },
  "unit": { "id": "unit_01...", "name": "Piece" },
  "options": [
    { "name": "Colour", "values": ["Red", "Blue"] },
    { "name": "Size", "values": ["S", "M"] }
  ],
  "variants": [
    {
      "id": "var_01...",
      "name": "Red / S",
      "sellingPrice": "9000.00",
      "stockStatus": "LOW_STOCK",
      "options": [
        { "name": "Colour", "value": "Red" },
        { "name": "Size", "value": "S" }
      ]
    }
  ],
  "stockStatus": "LOW_STOCK"
}
```

## Error responses

| Status | Code                | Condition                                                                                                                                                          |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `404`  | `PRODUCT_NOT_FOUND` | Product unknown, not published, deleted, or belongs to another store. Message: `"We couldn't find that product. It may have been removed or isn't available yet."` |
| `404`  | `STORE_NOT_FOUND`   | No store exists at that subdomain                                                                                                                                  |
| `429`  | `RATE_LIMITED`      | —                                                                                                                                                                  |

---

# GET /api/public/storefront/:subdomain/categories

Route group: public
Auth: none
Rate-limited: yes (same bucket)

Lists the store's categories for storefront navigation (category nav /
filters). Returns only the resolved store's categories.

## Request

Path params:

- `subdomain: string`

No query parameters.

## Success response

Status: `200`

```json
[
  { "id": "cat_01...", "name": "Bags" },
  { "id": "cat_02...", "name": "Shoes" }
]
```

## Error responses

| Status | Code              | Condition                         |
| ------ | ----------------- | --------------------------------- |
| `404`  | `STORE_NOT_FOUND` | No store exists at that subdomain |
| `429`  | `RATE_LIMITED`    | —                                 |
