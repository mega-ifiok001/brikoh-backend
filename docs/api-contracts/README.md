# API Contracts

This directory holds the agreed API contract between `brikoh-backend` and `brikoh-frontend`.
Both sides share this repo, so these docs are the **single source of truth** for every
request/response shape across the repo boundary.

These contracts are hand-maintained. Keep them in sync manually — a contract that has
drifted from the implementation is worse than no contract at all.

## Rules

- One markdown file per endpoint (or per closely-related endpoint group), named after
  the route, e.g. `POST /api/dashboard/products` -> `dashboard-products.md`.
- The contract doc is written BEFORE the implementation of a new endpoint.
- The backend implements exactly what the doc says — never hand-guess a shape that
  belongs to the other repo.
- The frontend consumes exactly what the doc says.
- When a contract evolves:
  1. Update the doc first (its own `docs:` commit, never buried in a `feat:` commit).
  2. Then implement/consume the change on either side.
- Timestamps in every contract are UTC ISO-8601 strings. Never store, send, or compare
  local-timezone timestamps anywhere in the system.
- Tenant-scoped resources always reference the tenant via the authenticated request
  context (`req.tenant.storeId`), never via client-supplied IDs.

## Endpoint contract template

````markdown
# METHOD /path

Route group: public | dashboard | webhooks | admin
Auth: none | bearer | bearer + store
Rate-limited: yes | no

## Request

Headers:

- `Content-Type: application/json`

Query params (if any):

- `param: type — description`

Path params (if any):

- `param: type — description`

Body (if any):

```json
{
  "field": "type — description"
}
```
````

## Success response

Status: `200`

```json
{
  "field": "type — description"
}
```

## Error responses

| Status | Condition                   |
| ------ | --------------------------- |
| `400`  | Invalid input               |
| `401`  | Unauthenticated             |
| `403`  | Unauthorized / wrong tenant |
| `404`  | Not found                   |
| `429`  | Rate limited                |

Error body shape (uniform across the API):

```json
{
  "error": {
    "code": "string",
    "message": "string"
  }
}
```

```

## Current contracts

- [GET /api/public/health](public-health.md)
- [POST /api/public/auth/register](auth-register.md)
- [POST /api/public/auth/login](auth-login.md)
- [POST /api/public/auth/google](auth-google.md)
- [POST /api/public/auth/refresh](auth-refresh.md)
- [POST /api/public/auth/logout](auth-logout.md)
- [POST /api/public/auth/verify](auth-verify.md)
- [POST /api/dashboard/resend-verification](auth-resend-verification.md)
- [GET /api/dashboard/me](dashboard-me.md)
- [POST /api/dashboard/onboarding](dashboard-onboarding.md)
- [GET/PUT /api/dashboard/templates (storefront templates)](dashboard-store-templates.md)
- [Products CRUD](dashboard-products.md)
- [POST /api/dashboard/products/:productId/stock-adjustments](dashboard-products-stock-adjustments.md)
- [Categories + units (catalog taxonomy)](dashboard-catalog.md)
- [Branches CRUD + stock transfers](dashboard-branches.md)
- [GET /api/dashboard/activity](dashboard-activity-log.md)
- [POST /api/dashboard/uploads/presign-product-image (signed uploads + auto image cleanup)](dashboard-uploads-presign.md)
- [Staff management](dashboard-staff.md)
- [Staff invites](dashboard-staff-invites.md)
- [POST /api/public/auth/accept-invite](auth-accept-invite.md)
- [GET /api/public/auth/accept-invite/:token](auth-accept-invite.md)
- [POST /api/public/checkout/:subdomain](public-checkout.md)
- [GET /api/public/storefront/:subdomain](public-storefront.md)
- [GET /api/public/orders/:orderId + POST .../mark-paid](public-orders.md)
- [GET/PUT /api/dashboard/payments/provider](dashboard-payments-settings.md)
- [GET /api/dashboard/payments/settlements](dashboard-payments-settlements.md)
- [POST /api/webhooks/paystack](public-webhook-paystack.md)
- [POST /api/webhooks/paystack-subscriptions (platform recurring billing)](public-webhook-paystack.md)
- [Subscription & plan enforcement](subscriptions-api.md)
- [Analytics endpoints](analytics-api.md)
- [POST /api/dashboard/orders — record a POS sale](dashboard-pos.md)
- [GET /api/dashboard/orders + /:orderId](dashboard-orders.md)
- [GET /api/dashboard/overview — home-screen widgets](dashboard-overview.md)
- [Dashboard settings — business, notifications, password, account](dashboard-settings.md)
- [Dashboard notifications — merchant alerts](dashboard-notifications.md)
- [Dashboard customers + credit repayments](dashboard-customers.md)
- [Dashboard customer groups](dashboard-customer-groups.md)
- [Dashboard discounts](dashboard-discounts.md)
- [Dashboard invoices + payments](dashboard-invoices.md)
- [GET /api/public/invoices/:invoiceId (customer invoice link)](public-invoice-link.md)
- [Dashboard suppliers](dashboard-suppliers.md)
- [Dashboard purchase orders](dashboard-purchase-orders.md)
- [GET /api/dashboard/wallet — wallet overview](dashboard-wallet.md)
- [Wallet bank accounts](dashboard-bank-accounts.md)
- [Merchant settlement bank accounts](dashboard-merchant-bank-accounts.md)
- [Dashboard delivery options](dashboard-delivery-options.md)
- [Wallet withdrawals](dashboard-withdrawals.md)
- [Dashboard expenses](dashboard-expenses.md)
- [Dashboard reports — P&L and expense breakdown](dashboard-reports.md)
- [Dashboard campaigns — storefront promotions](dashboard-campaigns.md)
- [Admin dashboard endpoints](admin-api.md)
- [Dashboard support tickets](dashboard-support-tickets.md)
- [Admin support tickets](admin-support-tickets.md)
- [Admin announcements](admin-announcements.md)
- [Dashboard announcements](dashboard-announcements.md)
- [Admin telemetry](admin-telemetry.md)
- [Admin payments awaiting confirmation](admin-payments-awaiting-confirmation.md)
- [Admin staff](admin-staff.md)

```
