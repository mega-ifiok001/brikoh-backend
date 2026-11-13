# Dashboard customers + credit repayments

Route group: dashboard
Auth: bearer + store (`authenticate` + `resolveTenant`) +
`authorize("customers.manage")` (owners pass implicitly)
Rate-limited: writes (`POST`, `PUT`, `DELETE`) at `60_000` window /
`300` requests; reads are not rate-limited

The store's address book (`Customer` rows) and the credit lifecycle:
customers are created implicitly by POS sales and storefront checkouts
(walk-in sales reuse the shared "Walk-in Customer" row), but this module
is the explicit management surface — CRUD, search, per-customer credit
balances, and **credit repayments** against outstanding `CREDIT` order
balances (`balanceDue` in `dashboard-orders.md`).

Every customer may belong to one **customer group**
(`dashboard-customer-groups.md`). Customers created without a group land
in the store's default "General" group.

Money values are decimal strings, never floats. All timestamps are UTC
ISO-8601.

## Credit model

- A `CREDIT` order with `amountPaid < total` has an outstanding balance
  (`total - amountPaid`).
- A repayment is money applied against that balance. Repayments are
  **append-only financial records** (`CreditRepayment` rows, DB-enforced
  like the stock ledger): `order.amountPaid` advances, and every
  repayment stays visible on the order detail and in the customer's
  repayment timeline.
- Repayment distribution: open credit orders (collectible statuses
  `PENDING | PAID | SHIPPED` only — `CANCELLED | REFUNDED | FAILED`
  orders never count as owing) are paid **oldest-first**, one
  `CreditRepayment` row per order touched.
- The dashboard overview's `quickStats.creditOwing`
  (`dashboard-overview.md`) applies the same collectible-status rule, so
  it always matches the sum of the customers' open balances.

---

## GET /api/dashboard/customers

Query parameters (all optional):

- `q` — case-insensitive substring match on `name`, `phone`, or `email`.
- `hasOutstandingCredit` — `true` / `false`: filter to customers with
  (or without) at least one open credit balance.
- `limit` — `1..100`, default `20`.
- `cursor` — the last `id` of the previous page (uuidv7 ids are
  time-ordered, so `id < cursor` gives the next older page); omitted
  starts at the newest.

Customers are returned newest-first (`createdAt` descending).

### Success response

Status: `200`

```json
{
  "items": [
    {
      "id": "019f...",
      "name": "Ade Okafor",
      "phone": "+234 801 234 5678",
      "email": "ade@example.com",
      "group": { "id": "019f...", "name": "General" } | null,
      "source": "POS | MANUAL | STOREFRONT | IMPORTED",
      "segment": ""NEW" | "REGULAR" | "VIP"",
      "ordersCount": 3,
      "totalSpent": "12500.00",
      "openCredit": "3500.00",
      "hasOutstandingCredit": true,
      "createdAt": "2026-08-01T10:00:00.000Z"
    }
  ],
  "nextCursor": "019f... | null"
}
```

- `source` — where the row was first created: `POS` (walk-in/card sale),
  `MANUAL` (dashboard form), `STOREFRONT` (public checkout), `IMPORTED`
  (CSV import). Never changes afterwards.
- `segment` — derived, computed live: `NEW` = zero orders ever; `VIP` =
  lifetime spend of at least 1,000,000.00 across successful sales
  (`PAID`/`SHIPPED` orders); `REGULAR` = anything in between.
- `ordersCount` — number of orders for this customer (all statuses).
- `totalSpent` — lifetime spend across `PAID`/`SHIPPED` orders; `"0.00"`
  when none.
- `group` — the customer's group (id + name); `null` when unassigned.
- `openCredit` — sum of `total - amountPaid` across the customer's open
  credit orders (collectible statuses only); `"0.00"` when none.
- `nextCursor` — pass as `cursor` to fetch the next page; `null` when
  there are no older customers.

### Error responses

| Status | Code                  | Condition                         |
| ------ | --------------------- | --------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Malformed query (`limit`, `cursor`, `hasOutstandingCredit`). |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `customers.manage`. |

Uniform error body shape (see `docs/api-contracts/README.md`).

---

## POST /api/dashboard/customers

Creates an address-book entry. The implicit rows created by POS/checkout
are identical in shape — this endpoint is just the explicit path.

### Request

Body:

```json
{
  "name": "string — required, 1-200",
  "phone": "string — optional, valid phone (7-17 digits)",
  "email": "string — optional, valid email (lowercased)",
  "groupId": "uuid? — optional; omitted customers land in the store's default \"General\" group"
}
```

### Success response

Status: `201` — the created customer (same shape as a list row).

A `customer.created` entry is appended to the store activity log.

### Error responses

| Status | Code                | Condition                          |
| ------ | ------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`  | Invalid fields.                    |
| `401`  | `UNAUTHORIZED`      | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `customers.manage`. |
| `404`  | `CUSTOMER_GROUP_NOT_FOUND` | `groupId` is not a group of this store. |
| `409`  | `CUSTOMER_EXISTS`   | A customer with this email already exists in the store (advisory — the DB has no unique constraint, so this is a pre-check, not a guarantee). |
| `429`  | `RATE_LIMITED`      | —                                |

---

## GET /api/dashboard/customers/:customerId

One customer with its credit state, repayment timeline, and recent
orders.

### Success response

Status: `200`

```json
{
  "customer": {
    "id": "019f...",
    "name": "Ade Okafor",
    "phone": "+234 801 234 5678",
    "email": "ade@example.com",
    "group": { "id": "019f...", "name": "General" } | null,
    "source": "POS",
    "segment": "REGULAR",
    "ordersCount": 3,
    "totalSpent": "12500.00",
    "openCredit": "3500.00",
    "hasOutstandingCredit": true,
    "createdAt": "2026-08-01T10:00:00.000Z"
  },
  "repayments": [
    {
      "id": "019f...",
      "orderId": "019f...",
      "amount": "500.00",
      "note": "Part payment",
      "recordedByName": "Chidi Manager",
      "createdAt": "2026-08-12T12:00:00.000Z"
    }
  ],
  "recentOrders": [
    {
      "id": "019f...",
      "status": "PAID",
      "paymentMethod": "CREDIT",
      "source": "POS",
      "total": "1250.00",
      "amountPaid": "750.00",
      "balanceDue": "500.00",
      "createdAt": "2026-08-12T10:00:00.000Z"
    }
  ]
}
```

- `repayments` — the customer's repayment timeline, newest first
  (cap: the 50 most recent).
- `recentOrders` — the 10 most recent orders (any status), shaped like
  `GET /api/dashboard/orders` list rows (`dashboard-orders.md`), without
  `discountAmount`/`itemCount`/`customer`/`branch`/`soldBy`.

### Error responses

| Status | Code                 | Condition                          |
| ------ | -------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`       | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `customers.manage`. |
| `404`  | `CUSTOMER_NOT_FOUND` | No such customer in this store.    |

---

## PUT /api/dashboard/customers/:customerId

Updates the customer's profile. Omitted fields keep their current value;
at least one field is required.

### Request

Body (all optional, at least one):

```json
{
  "name": "string — 1-200",
  "phone": "string — valid phone, or null to clear",
  "email": "string — valid email (lowercased), or null to clear",
  "groupId": "uuid — a group of this store, or null to unassign"
}
```

### Success response

Status: `200` — the updated customer (list-row shape).

A `customer.updated` entry is appended to the store activity log.

### Error responses

| Status | Code                | Condition                          |
| ------ | ------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`  | Invalid fields or empty body.      |
| `401`  | `UNAUTHORIZED`      | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `customers.manage`. |
| `404`  | `CUSTOMER_NOT_FOUND` | No such customer in this store.   |
| `404`  | `CUSTOMER_GROUP_NOT_FOUND` | `groupId` is not a group of this store. |
| `409`  | `CUSTOMER_EXISTS`   | The new email already belongs to another customer. |
| `429`  | `RATE_LIMITED`      | —                                |

---

## DELETE /api/dashboard/customers/:customerId

Permanently deletes the customer. Only customers with **no financial
history** (no orders, no invoices) can be deleted — the schema's
`Restrict` guards are surfaced as a clear 409. The shared "Walk-in
Customer" row is deletable like any other (POS re-creates it lazily on
the next walk-in sale).

### Success response

Status: `200`

```json
{ "ok": true }
```

A `customer.deleted` entry is appended to the store activity log.

### Error responses

| Status | Code                    | Condition                          |
| ------ | ----------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`          | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `customers.manage`. |
| `404`  | `CUSTOMER_NOT_FOUND`    | No such customer in this store.    |
| `409`  | `CUSTOMER_HAS_RECORDS`  | The customer has order or invoice history and cannot be deleted. |
| `429`  | `RATE_LIMITED`          | —                                |

---

## POST /api/dashboard/customers/:customerId/credits/repayments

Records a repayment against the customer's outstanding credit. The
amount is distributed across the customer's open credit orders
(oldest-first) until exhausted; one `CreditRepayment` row per order
touched. `order.amountPaid` advances by the allocated amount, and the
dashboard overview's `creditOwing` drops accordingly.

### Request

Body:

```json
{
  "amount": "string — required, > 0, at most 2 decimal places, max 99999999.99",
  "note": "string — optional, at most 500 characters"
}
```

### Success response

Status: `200`

```json
{
  "allocated": [
    { "orderId": "019f...", "amount": "1500.00" },
    { "orderId": "019f...", "amount": "2000.00" }
  ],
  "remaining": "0.00",
  "totalOutstanding": "3500.00"
}
```

- `allocated` — the orders paid, each with the exact amount applied
  (oldest-first).
- `remaining` — the request amount left after exhausting every open
  balance; always `"0.00"` because over-payment is rejected upfront.
- `totalOutstanding` — the customer's open credit *before* this
  repayment.

A `credit.repayment.recorded` entry is appended to the store activity
log (`detail` carries `amount`, the number of orders touched, and the
customer id).

### Error responses

| Status | Code                       | Condition                          |
| ------ | -------------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`         | Invalid `amount`/`note`, `amount <= 0`. |
| `401`  | `UNAUTHORIZED`             | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `customers.manage`. |
| `404`  | `CUSTOMER_NOT_FOUND`       | No such customer in this store.    |
| `409`  | `NO_OUTSTANDING_CREDIT`    | The customer has no open credit balance. |
| `409`  | `REPAYMENT_EXCEEDS_BALANCE`| `amount` exceeds `totalOutstanding`. |
| `429`  | `RATE_LIMITED`             | —                                |

Uniform error body shape (see `docs/api-contracts/README.md`).
---

## GET /api/dashboard/customers/export.csv

Downloads the store's full address book as a CSV file (no pagination).

- Response: `200 text/csv` with `Content-Disposition: attachment;
  filename="customers.csv"`.
- Columns: `name`, `phone`, `email`, `group`, `source`, `segment`,
  `ordersCount`, `totalSpent`, `openCredit`, `createdAt` (UTC ISO-8601).
- Rows ordered newest-first (same as the list). The exported `segment`
  and `totalSpent` are computed live at export time.

| Status | Code                     | Condition                          |
| ------ | ------------------------ | ---------------------------------- |
| `401`  | `UNAUTHORIZED`           | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `customers.manage`. |

---

## POST /api/dashboard/customers/import

One-phase, atomic CSV import: the whole batch is validated BEFORE any
write, and the insert is a single transaction — a validation failure
means nothing is imported. Duplicate rows are not an error: the first
row wins, later duplicates are skipped.

### Request

- `Content-Type: text/csv` (raw CSV body, NOT JSON).
- Rate-limited (`429 RATE_LIMITED` on excess).
- Max 500 data rows plus a header row; `400 VALIDATION_ERROR` beyond.

Header (first row, names case-insensitive):

```
name,phone,email,groupId
```

- `name` — required, 1-200 chars.
- `phone` — optional, valid phone (7-17 digits).
- `email` — optional, valid email; lowercased on import.
- `groupId` — optional; must be a group of this store, otherwise the
  import fails validation with the row number.

At least one of `phone`/`email` per row is required. Emails must be
unique within the file and within the store — an email already on file
is a duplicate, skipped by email first, then by phone (a phone already
on file for a different customer is also skipped). Every imported row
is created with `source = IMPORTED` and lands in the `groupId` column's
group (or the store's default "General" group when blank).

### Success response

Status: `201`

```json
{
  "created": 12,
  "skipped": 2,
  "errors": ["row 4: invalid phone", "row 7: invalid email"]
}
```

- `created` — rows inserted (this phase only adds rows, never updates).
- `skipped` — duplicates (email-then-phone match) and empty rows.
- `errors` — per-row validation failures, `row N: message` format;
  present only when non-empty.

A `customer.imported` activity entry records the outcome
(`detail` carries `created` and `skipped`).

### Error responses

| Status | Code                 | Condition                          |
| ------ | -------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`   | Malformed CSV, > 500 rows, unknown header columns, a `groupId` not in this store, or a row with neither phone nor email. |
| `401`  | `UNAUTHORIZED`       | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `customers.manage`. |
| `413`  | `PAYLOAD_TOO_LARGE`  | Body exceeds the request limit.   |
| `429`  | `RATE_LIMITED`       | —                                |

Uniform error body shape (see `docs/api-contracts/README.md`).
