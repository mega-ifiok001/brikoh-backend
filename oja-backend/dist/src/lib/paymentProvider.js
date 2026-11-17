/**
 * ============================================================
 * PAYMENT PROVIDER CONTRACT
 * ============================================================
 *
 * Every payment gateway (Paystack today; OPay, Monnify, Flutterwave…
 * later) plugs in as a single file behind this interface — the orders
 * service and webhooks service depend on `PaymentProvider`, never on a
 * provider's internals. Adding a provider means:
 *
 *   1. a new file in src/lib/providers/<name>.ts that satisfies
 *      `PaymentProvider` (with its own unit tests), and
 *   2. an entry in the provider allowlist (src/modules/payments/schemas)
 *      so merchants can configure it.
 *
 * No orders/webhooks code changes.
 *
 * Amounts are DECIMAL STRINGS ("1234.56") at the boundary — never
 * floats. Each provider converts to its minor unit (kobo, etc.) with
 * integer string math. Money stays Decimal(10,2) in the database.
 * ============================================================
 */
/**
 * Provider-side failure. `status` is the provider's HTTP status when one
 * was observed (0 for network-level failure). Messages never contain
 * credentials or secrets.
 */
export class PaymentProviderError extends Error {
    status;
    providerCode;
    constructor(status, message, providerCode) {
        super(message);
        this.name = "PaymentProviderError";
        this.status = status;
        this.providerCode = providerCode;
    }
}
//# sourceMappingURL=paymentProvider.js.map