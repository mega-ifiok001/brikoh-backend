# GET /api/admin/payments/awaiting-confirmation

Route group: admin. Auth: admin bearer. Permission: `admin:payments.awaiting-confirmation.view`.

Read-only cross-tenant queue of bank-transfer orders whose status is `AWAITING_PAYMENT`. Rows are ordered by `paymentSubmittedAt` ascending; legacy rows without a submission timestamp appear last.

```json
{
  "items": [{
    "orderId": "uuid",
    "orderNumber": "ORD-0001",
    "storeId": "uuid",
    "storeName": "Fresh Mart",
    "amount": "1250.00",
    "currency": "NGN",
    "paymentSubmittedAt": "2026-08-01T10:00:00.000Z",
    "waitingSeconds": 3600
  }]
}
```

`paymentSubmittedAt` and `waitingSeconds` are null for legacy rows with no claim timestamp. Every read is audit logged. No confirmation/rejection mutation endpoint exists; unsupported methods return the standard `404` route response.
