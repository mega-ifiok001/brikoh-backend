# Dashboard invoices + payments

Route group: dashboard
Auth: bearer + store (`authenticate` + `resolveTenant`) +
`authorize("invoices.manage")` (owners pass implicitly)
Rate-limited: writes (`POST`, `PUT`, `DELETE`, `issue`, `void`,
`payments`) at `60_000` window / `300` requests; reads are not
rate-limited

The invoicing surface: `Invoice` rows track money owed **independent of
fulfillment status** — issuing an invoice never touches product stock.
Line items capture prices at issue time (same pattern as orders); the
invoice lifecycle is `DRAFT → ISSUED → PAID` (or `VOID`), and payments
settle invoices through an **append-only ledger** (`InvoicePayment`
rows, DB-enforced like the stock ledger and credit repayments):
`invoice.amountPaid` advances, and every payment stays visible on the
invoice detail.

Money values are decimal strings, never floats. All timestamps are UTC
ISO-8601.

## Invoice model

- `DRAFT` — editable, deletable, not payable. No number yet.
- `ISSUED` — immutable (edits and deletes rejected), payable. `issuedAt`
  is stamped and the store-sequential number (`INV-0001`, ...) is
  assigned at issue time.
- `PAID` — terminal; reached automatically when `amountPaid` equals
  `total` (never set by hand).
- `VOID` — terminal; entered from `ISSUED` only, and only while the
  invoice has **no payments**. Voiding is the ledger-safe way to
  discard an issued invoice (an issued invoice can never be deleted).

`balanceDue` = `total - amountPaid`, always `"0.00"` once `PAID`. The
`dueDate` is informational only (no enforcement anywhere in this
phase).

An invoice's **share link** (`shareUrl`, present on the detail shape) is
built from the configured frontend origin once the invoice is `ISSUED`
and is the customer-facing address for the public invoice link. It is
`null` while `DRAFT` and never expires — a paid or voided invoice's link
still resolves (read-only, not payable) rather than going dead.

`linkEnabled` (also on the detail shape) is the on/off switch for the
public link, default `true` at issue. Turning it off 404s the public
read WITHOUT voiding the invoice — a way to revoke a link that was
shared too widely with no financial side effect. A disabled link is
indistinguishable from an unknown id (`404`), so disabling leaks
nothing.

---

## POST /api/dashboard/invoices

Creates a `DRAFT` invoice with its line items.

### Request

Body:

```json
{
  "customerId": "uuid — required, must exist in this store",
  "dueDate": "UTC ISO-8601 date — optional",
  "lineItems": [
    {
      "productId": "uuid — required, must exist in this store",
      "quantity": "integer — required, 1..1000000",
      "unitPriceAtIssue": "decimal string — required, > 0, max 99999999.99"
    }
  ]
}
```

- At least one line item is required; `total` is the sum of
  `quantity x unitPriceAtIssue` (prices captured at issue time, never
  re-read from the product).

### Success response

Status: `201` — the created invoice (detail shape below, minus
`payments`/`number`/`issuedAt`, which are empty/null while `DRAFT`).

A `invoice.created` entry is appended to the store activity log.

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Invalid fields, empty `lineItems`. |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `invoices.manage`. |
| `404`  | `CUSTOMER_NOT_FOUND`  | No such customer in this store.    |
| `404`  | `PRODUCT_NOT_FOUND`   | A line item names a product that does not exist in this store. |
| `429`  | `RATE_LIMITED`        | —                                |

---

## GET /api/dashboard/invoices

Query parameters (all optional):

- `status` — filter by `InvoiceStatus` (`DRAFT | ISSUED | PAID | VOID`).
- `q` — case-insensitive substring match on the customer's name or
  phone.
- `customerId` — filter to one customer's invoices.
- `limit` — `1..100`, default `20`.
- `cursor` — the last `id` of the previous page (uuidv7 ids are
  time-ordered, so `id < cursor` gives the next older page); omitted
  starts at the newest.

Invoices are returned newest-first (`createdAt` descending).

### Success response

Status: `200`

```json
{
  "items": [
    {
      "id": "019f...",
      "number": "INV-0001",
      "status": "ISSUED",
      "total": "1250.00",
      "amountPaid": "750.00",
      "balanceDue": "500.00",
      "dueDate": "2026-09-01T00:00:00.000Z",
      "itemCount": 2,
      "customer": { "id": "019f...", "name": "Ade Okafor", "phone": "+234..." },
      "createdAt": "2026-08-12T10:00:00.000Z",
      "issuedAt": "2026-08-12T10:05:00.000Z"
    }
  ],
  "nextCursor": "019f... | null"
}
```

- `number` — the store-sequential `INV-####`; `null` while `DRAFT`.
- `issuedAt` — `null` while `DRAFT`.
- `nextCursor` — pass as `cursor` to fetch the next page; `null` when
  there are no older invoices.

### Error responses

| Status | Code                  | Condition                         |
| ------ | --------------------- | --------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Malformed query (`status`, `limit`, `cursor`). |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `invoices.manage`. |

Uniform error body shape (see `docs/api-contracts/README.md`).

---

## GET /api/dashboard/invoices/:invoiceId

One invoice with its captured line items and payment timeline.

### Success response

Status: `200`

```json
{
  "invoice": {
    "id": "019f...",
    "number": "INV-0001",
    "status": "ISSUED",
    "total": "1250.00",
    "amountPaid": "750.00",
    "balanceDue": "500.00",
    "dueDate": "2026-09-01T00:00:00.000Z",
    "customer": { "id": "019f...", "name": "Ade Okafor", "phone": "+234..." },
    "createdAt": "2026-08-12T10:00:00.000Z",
    "issuedAt": "2026-08-12T10:05:00.000Z",
    "shareUrl": "https://app.example.com/invoice/019f...",
    "linkEnabled": true
  },
  "payments": [
    {
      "id": "019f...",
      "amount": "500.00",
      "note": "First installment",
      "recordedByName": "Chidi Manager",
      "createdAt": "2026-08-12T12:00:00.000Z"
    }
  ],
  "lineItems": [
    {
      "id": "019f...",
      "productId": "019f...",
      "productName": "Palm Oil 5L",
      "quantity": 2,
      "unitPriceAtIssue": "550.00",
      "lineTotal": "1100.00"
    }
  ]
}
```

- `lineItems[].lineTotal` = `quantity x unitPriceAtIssue` — prices
  captured at issue time, never re-read.
- `payments` — the invoice's payment timeline, oldest first; `[]` for
  invoices never paid. `balanceDue` is always consistent with these
  rows: `total - amountPaid` after every payment.
- Product names are read live (a soft-deleted product's lines still
  render with their captured prices).
- `shareUrl` — `null` while `DRAFT`; the customer-facing link (`POST
  /api/public/invoices/:invoiceId` view) once issued. The merchant
  copies it to send to the customer.

### Error responses

| Status | Code               | Condition                              |
| ------ | ------------------ | -------------------------------------- |
| `401`  | `UNAUTHORIZED`     | Missing, malformed, or expired token.  |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `invoices.manage`. |
| `404`  | `INVOICE_NOT_FOUND` | No such invoice in this store.        |

Uniform error body shape (see `docs/api-contracts/README.md`).

---

## PUT /api/dashboard/invoices/:invoiceId

Replaces the line items of a `DRAFT` invoice and updates its optional
fields. The `total` is recomputed from the new line items.

### Request

Body:

```json
{
  "dueDate": "UTC ISO-8601 date — optional, or null to clear",
  "lineItems": [
    {
      "productId": "uuid — required, must exist in this store",
      "quantity": "integer — required, 1..1000000",
      "unitPriceAtIssue": "decimal string — required, > 0, max 99999999.99"
    }
  ]
}
```

### Success response

Status: `200` — the updated invoice (detail shape).

A `invoice.updated` entry is appended to the store activity log.

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`    | Invalid fields, empty `lineItems`. |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `invoices.manage`. |
| `404`  | `INVOICE_NOT_FOUND`   | No such invoice in this store.     |
| `404`  | `PRODUCT_NOT_FOUND`   | A line item names a product that does not exist in this store. |
| `409`  | `INVOICE_NOT_DRAFT`   | The invoice is not `DRAFT` (issued invoices are immutable). |
| `429`  | `RATE_LIMITED`        | —                                |

---

## DELETE /api/dashboard/invoices/:invoiceId

Permanently deletes a `DRAFT` invoice (cascades its line items).

### Success response

Status: `200`

```json
{ "ok": true }
```

A `invoice.deleted` entry is appended to the store activity log.

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `invoices.manage`. |
| `404`  | `INVOICE_NOT_FOUND`   | No such invoice in this store.     |
| `409`  | `INVOICE_NOT_DRAFT`   | The invoice is not `DRAFT` (an issued invoice can only be voided). |
| `429`  | `RATE_LIMITED`        | —                                |

---

## POST /api/dashboard/invoices/:invoiceId/issue

Transitions `DRAFT → ISSUED`: stamps `issuedAt`, assigns the next
store-sequential `INV-####` number, and locks the invoice against
edits and deletion.

### Success response

Status: `200` — the invoice (detail shape).

A `invoice.issued` entry is appended to the store activity log.

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `invoices.manage`. |
| `404`  | `INVOICE_NOT_FOUND`   | No such invoice in this store.     |
| `409`  | `INVOICE_NOT_DRAFT`   | The invoice is not `DRAFT`.        |
| `429`  | `RATE_LIMITED`        | —                                |

---

## POST /api/dashboard/invoices/:invoiceId/void

Transitions `ISSUED → VOID`. Voided invoices are terminal and
immutable. An invoice with any payments cannot be voided — voiding
with money on the books would orphan it.

### Success response

Status: `200` — the invoice (detail shape).

A `invoice.voided` entry is appended to the store activity log.

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `invoices.manage`. |
| `404`  | `INVOICE_NOT_FOUND`   | No such invoice in this store.     |
| `409`  | `INVOICE_NOT_ISSUED`  | The invoice is not `ISSUED`.       |
| `409`  | `INVOICE_HAS_PAYMENTS`| The invoice has at least one payment and cannot be voided. |
| `429`  | `RATE_LIMITED`        | —                                |

---

## POST /api/dashboard/invoices/:invoiceId/disable-link

Turns the public share link **off** without voiding the invoice. The
customer-facing read (`GET /api/public/invoices/:invoiceId`) starts
returning `404` (indistinguishable from an unknown id, so nothing is
leaked) and `shareUrl` on the detail becomes `null`. The invoice itself
is untouched — it can still be paid and viewed in the dashboard. This is
the financial-side-effect-free way to revoke a link that was shared too
widely.

### Success response

Status: `200` — the invoice (detail shape, with `linkEnabled: false`).

A `invoice.link.disabled` entry is appended to the store activity log.

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `invoices.manage`. |
| `404`  | `INVOICE_NOT_FOUND`   | No such invoice in this store.     |
| `409`  | `INVOICE_NOT_ISSUED`  | The invoice is still `DRAFT` (no link to toggle). |
| `429`  | `RATE_LIMITED`        | —                                |

---

## POST /api/dashboard/invoices/:invoiceId/enable-link

Re-enables a disabled public share link. The public read works again and
`shareUrl` is restored.

### Success response

Status: `200` — the invoice (detail shape, with `linkEnabled: true`).

A `invoice.link.enabled` entry is appended to the store activity log.

### Error responses

| Status | Code                  | Condition                          |
| ------ | --------------------- | ---------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `invoices.manage`. |
| `404`  | `INVOICE_NOT_FOUND`   | No such invoice in this store.     |
| `409`  | `INVOICE_NOT_ISSUED`  | The invoice is still `DRAFT`.      |
| `429`  | `RATE_LIMITED`        | —                                |

---

## POST /api/dashboard/invoices/:invoiceId/payments

Records a payment against an `ISSUED` invoice. The payment is an
**append-only financial record**: one immutable `InvoicePayment` row,
`invoice.amountPaid` advanced, and the invoice transitions to `PAID`
automatically when the balance is settled.

**Customer receipt:** a receipt email is sent to the invoice customer
after the payment is recorded, when the store has `receiptsEnabled` on and
the customer has an email. See `dashboard-settings.md` → "Customer
receipts".

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
  "invoiceId": "019f...",
  "status": "ISSUED",
  "allocated": "500.00",
  "balanceDue": "500.00",
  "totalOutstanding": "1000.00"
}
```

- `status` — `ISSUED` or `PAID` *after* this payment.
- `totalOutstanding` — the balance before this payment.
- `balanceDue` — the balance after (`totalOutstanding - allocated`).

A `invoice.payment.recorded` entry is appended to the store activity
log (`detail` carries the amount and the payment id).

### Error responses

| Status | Code                       | Condition                          |
| ------ | -------------------------- | ---------------------------------- |
| `400`  | `VALIDATION_ERROR`         | Invalid `amount`/`note`, `amount <= 0`. |
| `401`  | `UNAUTHORIZED`             | Missing, malformed, or expired token. |
| `403`  | `INSUFFICIENT_PERMISSIONS` | Staff role without `invoices.manage`. |
| `404`  | `INVOICE_NOT_FOUND`        | No such invoice in this store.     |
| `409`  | `INVOICE_NOT_ISSUED`       | The invoice is not `ISSUED` (drafts are not payable; `PAID`/`VOID` are terminal). |
| `409`  | `PAYMENT_EXCEEDS_BALANCE`  | `amount` exceeds the remaining balance. |
| `429`  | `RATE_LIMITED`             | —                                |

Uniform error body shape (see `docs/api-contracts/README.md`).

---

## Out of scope (this phase)

- Linking invoice payments to the customer's order-credit balance
  (`dashboard-customers.md` stays order-only).
- Emailing or printing invoices; PDF generation. The merchant shares
  the public link out-of-band (WhatsApp, SMS, etc.); there is no
  in-app send. (A payment **receipt** email IS sent on payment — see
  "Customer receipts" above — but the invoice document itself is not.)
- `dueDate` enforcement or overdue signalling.
- Revenue recognition: invoiced amounts do not feed the sales
  analytics (those read `Order` rows only).