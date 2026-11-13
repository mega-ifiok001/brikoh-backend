# Public invoice link

Route group: public
Auth: none (the invoice id is the only credential)
Rate-limited: `60_000` window / `300` requests (group) plus a per-route
`30`/min limit on `GET /:invoiceId` to blunt UUID enumeration

The customer-facing read of an issued invoice. The merchant sends the
customer the invoice's `shareUrl` (see `dashboard-invoices.md`); the
customer opens it, reads the invoice, and pays the store's displayed
account number. The customer **cannot interact** — this is a read-only
projection, and the owner records the payment on their side with the
existing `POST /api/dashboard/invoices/:invoiceId/payments` flow once
they see the money land.

The link **never expires**. It goes live when the invoice is issued and
stays resolvable forever: a paid or voided invoice still renders, just
marked not-payable with no account number shown. This is a
status-driven rule, not a clock.

## Model behaviour

- `ISSUED` (with an unpaid balance) — full detail: items, totals,
  amount due, and the store's **default** bank account.
- `DRAFT` — **`404`**. An unissued invoice has no number and is still
  editable, so it is never shareable. Unknown ids are indistinguishable
  from DRAFT (`404`) to hide whether an invoice exists.
- `linkEnabled: false` (the merchant disabled the link) — **`404`**,
  indistinguishable from an unknown id. The invoice is untouched
  (still payable/editable in the dashboard) — only its public face
  disappears.
- `PAID` / `VOID` — the invoice renders with a terminal status and
  `isPayable: false`; the account number is omitted.

## GET /api/public/invoices/:invoiceId

### Path params

- `invoiceId: uuid — the invoice id from the merchant's dashboard.`

### Success response

Status: `200`

```json
{
  "id": "019f...",
  "number": "INV-0001",
  "status": "ISSUED",
  "storeName": "Mama Ade Stores",
  "currency": "NGN",
  "customerName": "Ade Okafor",
  "total": "1250.00",
  "amountPaid": "250.00",
  "balanceDue": "1000.00",
  "dueDate": "2026-09-01T00:00:00.000Z",
  "issuedAt": "2026-08-12T12:05:00.000Z",
  "isPayable": true,
  "bankDetails": {
    "bankName": "Access Bank",
    "accountName": "Adebayo Idowu",
    "accountNumber": "0123456789"
  },
  "lineItems": [
    {
      "id": "019f...",
      "productName": "Palm Oil 5L",
      "quantity": 2,
      "unitPrice": "550.00",
      "lineTotal": "1100.00"
    }
  ]
}
```

- `balanceDue` = `total - amountPaid`, always `"0.00"` once `PAID`.
- `isPayable` — `true` only while `ISSUED` with an unpaid balance; the
  account number is only ever returned alongside `isPayable: true`.
- `bankDetails` — the store's **default** bank account (`isDefault` with
  a non-null `accountNumber`), and only while the invoice is payable.
  `null` when the store has not configured a default account, or once
  the invoice is `PAID`/`VOID`.
- `lineItems[].lineTotal` = `quantity x unitPrice`. Prices are captured
  at issue time.
- The payment ledger, the customer's contact details, the store id, and
  any internal ids are **never** returned.

### Error responses

| Status | Code               | Condition                           |
| ------ | ------------------ | ----------------------------------- |
| `400`  | `VALIDATION_ERROR` | `invoiceId` is not a well-formed uuid. |
| `404`  | `INVOICE_NOT_FOUND`| No such invoice, or the invoice is still `DRAFT`. |
| `429`  | `RATE_LIMITED`     | —                                 |

## Read-only surface

Only `GET /:invoiceId` is routed. `POST`, `PUT`, `PATCH`, and `DELETE`
against the public path are not handled (the dashboard route handles
the record-payment write under auth). The public endpoint never mutates
anything.

Uniform error body shape (see `docs/api-contracts/README.md`).
