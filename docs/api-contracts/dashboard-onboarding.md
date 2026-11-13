# POST /api/dashboard/onboarding

Route group: dashboard
Auth: bearer (authenticate only — the account has no tenant yet, so
`resolveTenant` is deliberately NOT mounted on this route)
Rate-limited: yes

Creates the account's Store and Owner records in a single transaction.
This is the step that moves a freshly registered account from
`needsOnboarding: true` to a full tenant context. It may only run once
per account; a second call is rejected.

The account's email must be verified before this endpoint succeeds: a
fresh registration is sent a verification email (see `auth-register.md`
and `auth-verify.md`), and an unverified account gets
`403 VERIFICATION_REQUIRED`. This is the only client-visible effect of
email verification — sessions, `/me`, and `/auth/refresh` all work
before it.

The form collects the business profile only — the owner is never asked
whether they want a website. Every new store is given a public
storefront automatically: the server derives the `subdomain` from the
store name (e.g. `Ades Boutique` → `ades-boutique`) and resolves
collisions by appending a numeric suffix (`ades-boutique-2`, ...), with
a random letters-only fallback for names that cannot produce a valid
slug. The store is reachable at `/api/public/checkout/:subdomain`.

Subdomain rules (server-side, never client-supplied):

- Store names are letters and single spaces only (`[a-z]`/`A-Z`),
  1-120 chars — digits, punctuation, and symbols are rejected up front.
- The base subdomain derived from the name is lowercase letters and
  hyphens only (no digits), 4-63 chars; collision resolution appends a
  numeric suffix (`ades-boutique-2`, `ades-boutique-3`, ...).
- A store name whose derived subdomain would be reserved by the
  platform (e.g. `Brikoh`, `www`, product and support names) is
  rejected with `409 SUBDOMAIN_RESERVED`.
- A store name too short to derive a 4-char subdomain is rejected with
  `409 SUBDOMAIN_TOO_SHORT`.

## Request

Headers:

- `Authorization: Bearer <accessToken>`
- `Content-Type: application/json`

Body:

```json
{
  "name": "string — business name, 1-120 chars, letters and spaces only",
  "businessType": "RETAIL | FOOD_AND_BEVERAGE | FASHION_AND_WEARABLES | HEALTH_AND_BEAUTY | ELECTRONICS | PROFESSIONAL_SERVICES | AGRICULTURE | OTHER",
  "location": "string — free text, 2-120 chars (e.g. \"Lagos, Nigeria\")",
  "currency": "NGN | USD | GHS | KES | ZAR — optional, defaults to NGN",
  "businessPhone": "string — required, 7-17 chars of digits (optional leading +, spaces, dashes, parens)",
  "templateId": "string — optional; id of a storefront template from GET /api/dashboard/templates (see dashboard-store-templates.md)"
}
```

- Unknown keys (e.g. a stale `wantWebsite` from an older client) are
  rejected with `400 VALIDATION_ERROR` — the shape is strict.
- The `subdomain` is never accepted from the client; it is always
  derived server-side from `name`.
- `templateId` is optional. When omitted the server defaults the store
  to the first visible template (lowest `sortOrder`) of the
  pre-subscription STARTER set; when provided it must be in that set,
  otherwise `400 TEMPLATE_NOT_AVAILABLE` (see
  `dashboard-store-templates.md` for the tier rules).

## Success response

Status: `201`

```json
{
  "user": {
    "accountId": "string",
    "email": "string",
    "firstName": "string | null",
    "lastName": "string | null",
    "phone": "string | null",
    "role": "OWNER",
    "storeId": "string",
    "storeName": "string",
    "subdomain": "string — auto-generated from the store name",
    "needsOnboarding": false,
    "verified": true
  }
}
```

- No new token pair is issued: the access token carries no tenant
  authority (claims are never trusted; tenant resolution is
  database-backed), so the existing session works unchanged.
- The created store carries `templateId` = the provided id, or the first
  visible template of the STARTER set when omitted.

## Error responses

| Status | Code                  | Condition                                                                                                |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Malformed body (name, businessType, location, businessPhone) or unknown keys                              |
| `400`  | `TEMPLATE_NOT_AVAILABLE` | `templateId` is not in the pre-subscription STARTER set (unknown, inactive, or beyond the STARTER count) |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token                                                                     |
| `403`  | `VERIFICATION_REQUIRED` | The account's email is not verified — complete `POST /api/public/auth/verify` first                      |
| `409`  | `ALREADY_ONBOARDED`   | Account already owns a store (onboarding is once-only)                                                   |
| `409`  | `SUBDOMAIN_RESERVED`  | The store name maps to a reserved subdomain (e.g. `Brikoh`, `www`)                                       |
| `409`  | `SUBDOMAIN_TOO_SHORT` | The store name is too short to derive a 4-character subdomain                                            |
| `429`  | `RATE_LIMITED`        | Too many requests                                                                                        |

Uniform error body shape (see `docs/api-contracts/README.md`).
