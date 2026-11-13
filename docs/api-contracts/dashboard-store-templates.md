# GET /api/dashboard/templates, PUT /api/dashboard/templates & PUT /api/dashboard/templates/customization

Route group: dashboard
Auth:

- GET: bearer (authenticate only — the catalog must be fetchable DURING
  onboarding, before the account has a store, so `resolveTenant` is
  deliberately NOT mounted on it)
- PUT /templates and PUT /templates/customization: bearer + store,
  **owner-only** (`requireOwner`)
  Rate-limited: no (read-only catalog + cheap storefront setting writes)

Storefront templates: the catalog of storefront designs a merchant can
apply to their public storefront. Templates are a dev-controlled catalog
(seeded data — the catalog itself is not merchant-editable); what a given
account can SEE is gated by a **template count** derived from the plan,
the same shape as the resource caps:

| Tier         | templateCap  |
| ------------ | ------------ |
| `STARTER`    | `3`          |
| `PRO`        | `5`          |
| `ENTERPRISE` | `null` (all) |

The visible set is a **superset**: the catalog is ordered by
`sortOrder`, and the first N (by the tier's `templateCap`) are visible —
STARTER sees templates 1–3, PRO sees 1–5, ENTERPRISE sees every active
template. Upgrading never hides a template, it reveals more. A
`Subscription` row whose `templateCap` column is non-null **overrides**
the tier default (same rule as the other caps).

Pre-subscription behavior (deliberate deviation from the caps' "no
subscription = unlimited" rule): a store with **no subscription row** —
which is every store at onboarding, since billing is not wired yet —
sees the STARTER set (3 templates). This keeps template selection usable
from day one. A subscription whose status is not ACTIVE/TRIALING also
degrades to the STARTER set (templates are cosmetic; the storefront does
not break, it just shows the base set).

The selection itself is stored on the store (`Store.templateId`); a
store with no selection renders the client's default template until one
is picked.

Beyond selection, a merchant can **customize** the chosen template's
brand fields (accent color, logo, hero text, announcement bar) via
`PUT /api/dashboard/templates/customization`. Customization is available
to EVERY tier — it is not tier-gated (no `SUBSCRIPTION_INACTIVE` lock
either: like template selection, it is cosmetic). The customization is
stored per-store (`Store.templateSettings`); `null` (or any omitted
field) means "use the template's default".

---

## GET /api/dashboard/templates

Returns the visible template catalog for the account's tier, resolved
from the account's store subscription (or the STARTER set for a
tenant-less account pre-onboarding / an inactive subscription).

### Request

Headers:

- `Authorization: Bearer <accessToken>`

No path, query, or body parameters.

### Success response

Status: `200`

```json
{
  "templates": [
    {
      "id": "019f…",
      "slug": "market",
      "name": "Market Classic",
      "description": "Simple single-column storefront",
      "previewUrl": null
    }
  ],
  "tier": "STARTER",
  "visibleCount": 3,
  "selectedTemplateId": null,
  "settings": {
    "accentColor": "#B45309",
    "logoUrl": "https://cdn.example.com/logo.png",
    "heroText": "Fresh from Lagos",
    "heroSubtext": "Handpicked goods, delivered daily",
    "announcementBar": {
      "enabled": true,
      "text": "Free delivery on orders over ₦50,000"
    }
  }
}
```

- `templates` — the visible active templates ordered by `sortOrder`
  (ascending), already cut to the tier's count.
- `tier` — the tier whose set was applied: `STARTER | PRO | ENTERPRISE`.
  A tenant-less account (pre-onboarding) and an inactive subscription
  report `STARTER`.
- `visibleCount` — the number of templates returned; `null` means "all"
  (ENTERPRISE). Mirrors `templateCap` from the plan.
- `selectedTemplateId` — the store's current selection, or `null` before
  onboarding (no store yet) / before any selection.
- `settings` — the store's saved template customization (see
  `PUT /api/dashboard/templates/customization` below), or `null` when
  never customized. Each field is `null`/absent until set; `null` means
  "use the template's default".

### Error responses

| Status | Code           | Condition                            |
| ------ | -------------- | ------------------------------------ |
| `401`  | `UNAUTHORIZED` | Missing, malformed, or expired token |

Uniform error body shape (see `docs/api-contracts/README.md`).

---

## PUT /api/dashboard/templates

Sets the store's storefront template (`Store.templateId`). **Owner-only**
(branding is a tenant-root setting, same trust level as staff management
and subscriptions). The target template must be in the store's visible
set for its tier — a template beyond the count (or an unknown/inactive
one) is rejected BEFORE any write, including when a caller attempts to
bypass the UI and send the request directly.

### Request

Headers:

- `Authorization: Bearer <accessToken>`
- `Content-Type: application/json`

Body:

```json
{
  "templateId": "019f… — the id of a template visible on the store's tier"
}
```

### Success response

Status: `200`

```json
{
  "template": {
    "id": "019f…",
    "slug": "market",
    "name": "Market Classic",
    "description": "Simple single-column storefront",
    "previewUrl": null
  }
}
```

### Error responses

| Status | Code                       | Condition                                                                                                                     |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`         | Malformed body (missing/blank `templateId`).                                                                                  |
| `400`  | `TEMPLATE_NOT_AVAILABLE`   | The template is unknown, inactive, or not in the store's visible set for its tier (e.g. a STARTER store picking template #5). |
| `401`  | `UNAUTHORIZED`             | Missing, malformed, or expired token.                                                                                         |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role (owner required).                                                                                                  |

Uniform error body shape (see `docs/api-contracts/README.md`).

---

## PUT /api/dashboard/templates/customization

Sets the store's template customization (`Store.templateSettings`) —
the brand fields layered on top of the chosen template. **Owner-only**
(branding is a tenant-root setting, same trust level as template
selection). Available to every tier; not gated by subscription status
(customization is cosmetic, like template selection).

Semantics are **replace**: the body is the full settings object and
every omitted key is cleared back to the template default. `{}` clears
everything. The shape is strict — unknown keys are rejected with
`400 VALIDATION_ERROR` before any write, including when a caller
attempts to bypass the UI and send the request directly.

### Request

Headers:

- `Authorization: Bearer <accessToken>`
- `Content-Type: application/json`

Body (every field optional; omitted = cleared to the template default):

```json
{
  "accentColor": "#B45309 — hex #RRGGBB",
  "logoUrl": "https://cdn.example.com/logo.png — https URL (uploaded via the uploads presign flow)",
  "heroText": "string — 1-80 chars",
  "heroSubtext": "string — 1-160 chars",
  "announcementBar": {
    "enabled": true,
    "text": "string — 1-140 chars"
  }
}
```

### Success response

Status: `200` — the saved customization (same shape as the request;
`null` fields are returned as `null`).

```json
{
  "settings": {
    "accentColor": "#B45309",
    "logoUrl": null,
    "heroText": "Fresh from Lagos",
    "heroSubtext": null,
    "announcementBar": null
  }
}
```

### Error responses

| Status | Code                       | Condition                                                                                      |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`         | Malformed body: bad hex color, non-https/invalid `logoUrl`, text over length, or unknown keys. |
| `401`  | `UNAUTHORIZED`             | Missing, malformed, or expired token.                                                          |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role (owner required).                                                                   |

Uniform error body shape (see `docs/api-contracts/README.md`).

---

## Onboarding integration

`POST /api/dashboard/onboarding` accepts an **optional** `templateId`
(see `dashboard-onboarding.md`). When omitted, the server defaults the
store to the first visible template (lowest `sortOrder`) of the
pre-subscription STARTER set. When provided, it must be in that set —
a template beyond the STARTER count is rejected with
`400 TEMPLATE_NOT_AVAILABLE` before any write, same as PUT.
