# Dashboard customer groups

Route group: dashboard
Auth: bearer + store (`authenticate` + `resolveTenant`) +
`authorize("customers.manage")` (owners pass implicitly)
Rate-limited: writes (`POST`, `PUT`, `DELETE`) at `60_000` window /
`60` requests; reads are not rate-limited

Customer groups segment the store's address book. A group is a label with
an optional **auto-applied discount** (see `dashboard-discounts.md`): when
a member of the group buys at the POS and no explicit discount is chosen,
the group's discount is applied automatically.

Every store has an implicit **"General"** group — the default destination
for customers created implicitly by POS sales, storefront checkouts, and
customers created without a group. It is created lazily on first use (like
the shared "Walk-in Customer" row) and behaves like any other group.

All timestamps are UTC ISO-8601. Money values are decimal strings.

## GET /api/dashboard/customer-groups

Lists the store's groups with their current member counts.

### Success response

Status: `200`

```json
{
  "items": [
    {
      "id": "019f...",
      "name": "General",
      "description": null,
      "memberCount": 42,
      "discount": { "id": "019f...", "name": "VIP 10%", "type": "PERCENTAGE", "value": "10.00" } | null,
      "createdAt": "2026-08-01T10:00:00.000Z",
      "updatedAt": "2026-08-01T10:00:00.000Z"
    }
  ]
}
```

- `memberCount` — number of customers currently assigned to the group.
- `discount` — the group's auto-applied discount, when attached; the
  embedded shape is the discount list-row shape (see
  `dashboard-discounts.md`).

### Error responses

| Status | Code                 | Condition                         |
| ------ | -------------------- | --------------------------------- |
| `401`  | `UNAUTHORIZED`       | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `customers.manage`. |

Uniform error body shape (see `docs/api-contracts/README.md`).

---

## POST /api/dashboard/customer-groups

### Request

Body:

```json
{
  "name": "string — required, 1-100, unique per store (case-insensitive)",
  "description": "string — optional, at most 500 characters",
  "discountId": "uuid? — an ACTIVE discount of this store, or null"
}
```

### Success response

Status: `201` — the created group (list-row shape, `memberCount` 0).

A `customerGroup.created` entry is appended to the store activity log.

### Error responses

| Status | Code                   | Condition                          |
| ------ | ---------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`     | Invalid fields.                    |
| `401`  | `UNAUTHORIZED`         | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `customers.manage`. |
| `404`  | `DISCOUNT_NOT_FOUND`   | `discountId` is not a discount of this store. |
| `409`  | `GROUP_NAME_TAKEN`     | A group with this name already exists in the store. |
| `429`  | `RATE_LIMITED`         | —                                |

---

## GET /api/dashboard/customer-groups/:groupId

One group with its members (up to 50 most recent) and full discount.

### Success response

Status: `200`

```json
{
  "group": {
    "id": "019f...",
    "name": "VIP",
    "description": "Wholesale buyers",
    "memberCount": 5,
    "discount": { "id": "019f...", "name": "VIP 10%", "type": "PERCENTAGE", "value": "10.00" } | null,
    "createdAt": "2026-08-01T10:00:00.000Z",
    "updatedAt": "2026-08-01T10:00:00.000Z"
  },
  "members": [
    { "id": "019f...", "name": "Ade Okafor", "phone": "+234 801 234 5678", "email": "ade@example.com", "createdAt": "2026-08-01T10:00:00.000Z" }
  ]
}
```

### Error responses

| Status | Code                   | Condition                          |
| ------ | ---------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`         | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `customers.manage`. |
| `404`  | `CUSTOMER_GROUP_NOT_FOUND` | No such group in this store.   |

---

## PUT /api/dashboard/customer-groups/:groupId

Updates the group. Omitted fields keep their current value; at least one
field is required.

### Request

Body (all optional, at least one):

```json
{
  "name": "string — 1-100, unique per store (case-insensitive)",
  "description": "string — at most 500 characters, or null to clear",
  "discountId": "uuid — an ACTIVE discount of this store, or null to detach"
}
```

### Success response

Status: `200` — the updated group (list-row shape).

A `customerGroup.updated` entry is appended to the store activity log.

### Error responses

| Status | Code                   | Condition                          |
| ------ | ---------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`     | Invalid fields or empty body.      |
| `401`  | `UNAUTHORIZED`         | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `customers.manage`. |
| `404`  | `CUSTOMER_GROUP_NOT_FOUND` | No such group in this store.   |
| `404`  | `DISCOUNT_NOT_FOUND`   | `discountId` is not a discount of this store. |
| `409`  | `GROUP_NAME_TAKEN`     | The new name already belongs to another group. |
| `429`  | `RATE_LIMITED`         | —                                |

---

## DELETE /api/dashboard/customer-groups/:groupId

Deletes the group. A group with **any assigned customers** cannot be
deleted (`409 GROUP_HAS_CUSTOMERS`) — reassign or delete those customers
first, or reuse the shared "General" group. The "General" group itself is
deletable like any other (POS/checkout re-create it lazily on the next
sale).

### Success response

Status: `200`

```json
{ "ok": true }
```

A `customerGroup.deleted` entry is appended to the store activity log.

### Error responses

| Status | Code                    | Condition                          |
| ------ | ----------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`          | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `customers.manage`. |
| `404`  | `CUSTOMER_GROUP_NOT_FOUND` | No such group in this store.    |
| `409`  | `GROUP_HAS_CUSTOMERS`   | The group has assigned customers and cannot be deleted. |
| `429`  | `RATE_LIMITED`          | —                                |

Uniform error body shape (see `docs/api-contracts/README.md`).
