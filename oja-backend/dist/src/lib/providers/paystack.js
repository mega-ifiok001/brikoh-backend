import { createHmac, timingSafeEqual } from "node:crypto";
import { PaymentProviderError } from "../paymentProvider.js";
/**
 * ============================================================
 * PAYSTACK PROVIDER
 * ============================================================
 * Implements lib/paymentProvider.ts for Paystack (transaction
 * initialize + webhook signature verification). Keys are merchant
 * bring-your-own-keys loaded from PaymentCredential rows; the API key
 * travels only in the Authorization header and is never logged.
 *
 * The transport is injectable (`fetchFn`, defaulting to global fetch)
 * so tests exercise the full HTTP contract with a stub — no network.
 * ============================================================
 */
export const PAYSTACK_DEFAULT_API_BASE = "https://api.paystack.co";
export function createPaystackProvider(options) {
    const apiBase = options.apiBase ?? PAYSTACK_DEFAULT_API_BASE;
    const fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
    /**
     * Shared Paystack request: auth header, JSON parse, and the uniform
     * PaymentProviderError translation (static messages — the underlying
     * error can echo secrets and would be logged by the error handler).
     */
    async function request(path, init) {
        let response;
        try {
            response = await fetchFn(`${apiBase}${path}`, {
                method: init?.method ?? "GET",
                headers: {
                    Authorization: `Bearer ${options.secretKey}`,
                    ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
                },
                ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
            });
        }
        catch {
            throw new PaymentProviderError(0, "paystack is unreachable");
        }
        const body = (await response.json().catch(() => ({})));
        if (!response.ok || body.status !== true) {
            throw new PaymentProviderError(response.status, body.message ?? `paystack rejected the request (HTTP ${response.status})`, response.status === 401 ? "INVALID_API_KEY" : undefined);
        }
        if (body.data === undefined) {
            throw new PaymentProviderError(502, "paystack response was missing the data");
        }
        return body.data;
    }
    return {
        id: "paystack",
        async initiateCheckout(input) {
            let response;
            try {
                response = await fetchFn(`${apiBase}/transaction/initialize`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${options.secretKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        email: input.email,
                        amount: amountToKobo(input.amount),
                        reference: input.reference,
                        currency: input.currency,
                        metadata: input.metadata,
                    }),
                });
            }
            catch {
                // Static message on purpose: the underlying error can echo
                // secrets (URLs, headers) and would be logged by the global
                // error handler.
                throw new PaymentProviderError(0, "paystack is unreachable");
            }
            const body = (await response.json().catch(() => ({})));
            if (!response.ok || body.status !== true) {
                throw new PaymentProviderError(response.status, body.message ?? `paystack rejected the transaction (HTTP ${response.status})`, response.status === 401 ? "INVALID_API_KEY" : undefined);
            }
            const { authorization_url: authorizationUrl, access_code: accessCode, reference, } = body.data ?? {};
            if (typeof authorizationUrl !== "string" || typeof reference !== "string") {
                throw new PaymentProviderError(502, "paystack response was missing the authorization data");
            }
            return { reference, authorizationUrl, accessCode };
        },
        async verifyWebhookSignature(rawBody, signature) {
            const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
            if (!/^[0-9a-f]+$/i.test(signature)) {
                return false;
            }
            const expected = createHmac("sha512", options.secretKey).update(bodyBuffer).digest();
            const provided = Buffer.from(signature, "hex");
            if (expected.length !== provided.length) {
                return false;
            }
            return timingSafeEqual(expected, provided);
        },
        async getTransactionStatus(reference) {
            let response;
            try {
                response = await fetchFn(`${apiBase}/transaction/verify/${encodeURIComponent(reference)}`, {
                    method: "GET",
                    headers: { Authorization: `Bearer ${options.secretKey}` },
                });
            }
            catch {
                // Static message on purpose: the underlying error can echo
                // secrets and would be logged by the global error handler.
                throw new PaymentProviderError(0, "paystack is unreachable");
            }
            const body = (await response.json().catch(() => ({})));
            if (!response.ok || body.status !== true) {
                throw new PaymentProviderError(response.status, body.message ?? `paystack rejected the transaction (HTTP ${response.status})`, response.status === 401 ? "INVALID_API_KEY" : undefined);
            }
            if (body.data === undefined || typeof body.data.status !== "string") {
                throw new PaymentProviderError(502, "paystack response was missing the transaction data");
            }
            const { status, paid_at: paidAt, amount, currency } = body.data;
            return {
                status: status === "success" || status === "failed" || status === "pending" ? status : "unknown",
                paidAt: typeof paidAt === "string" ? paidAt : null,
                amount: typeof amount === "number" ? koboToNaira(String(amount)) : null,
                currency: typeof currency === "string" ? currency.toUpperCase() : null,
            };
        },
        async resolveBankAccount(bankCode, accountNumber) {
            const data = await request("/bank/resolve", {
                method: "POST",
                body: { bank_code: bankCode, account_number: accountNumber },
            });
            if (typeof data.account_name !== "string" || data.account_name.length === 0) {
                throw new PaymentProviderError(502, "paystack response was missing the account name");
            }
            return { accountName: data.account_name };
        },
        async createTransferRecipient(input) {
            const data = await request("/transferrecipient", {
                method: "POST",
                body: {
                    type: "nuban",
                    name: input.name,
                    account_number: input.accountNumber,
                    bank_code: input.bankCode,
                    currency: "NGN",
                },
            });
            if (typeof data.recipient_code !== "string" || data.recipient_code.length === 0) {
                throw new PaymentProviderError(502, "paystack response was missing the recipient code");
            }
            return { recipientCode: data.recipient_code };
        },
        async initiateTransfer(input) {
            const data = await request("/transfer", {
                method: "POST",
                body: {
                    source: "balance",
                    amount: amountToKobo(input.amount),
                    recipient: input.recipientCode,
                    reference: input.reference,
                    currency: "NGN",
                },
            });
            if (typeof data.transfer_code !== "string" || data.transfer_code.length === 0) {
                throw new PaymentProviderError(502, "paystack response was missing the transfer code");
            }
            return { transferCode: data.transfer_code };
        },
        async verifyTransfer(reference) {
            const data = await request(`/transfer/verify/${encodeURIComponent(reference)}`);
            if (typeof data.status !== "string") {
                throw new PaymentProviderError(502, "paystack response was missing the transfer status");
            }
            return {
                status: data.status === "success"
                    ? "success"
                    : data.status === "failed" || data.status === "reversed" || data.status === "abandoned"
                        ? "failed"
                        : data.status === "pending" || data.status === "in_progress" || data.status === "otp"
                            ? "pending"
                            : "unknown",
                fee: typeof data.fee === "number" ? koboToNaira(String(data.fee)) : null,
            };
        },
        // ---- Platform-side recurring billing (see PaymentProvider) ----
        async createPlan(input) {
            const data = await request("/plan", {
                method: "POST",
                body: {
                    name: input.name,
                    amount: amountToKobo(input.amount),
                    interval: input.interval,
                    currency: "NGN",
                },
            });
            if (typeof data.plan_code !== "string" || data.plan_code.length === 0) {
                throw new PaymentProviderError(502, "paystack response was missing the plan code");
            }
            return { planCode: data.plan_code };
        },
        async initializeSubscription(input) {
            let response;
            try {
                response = await fetchFn(`${apiBase}/transaction/initialize`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${options.secretKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        email: input.email,
                        plan: input.planCode,
                        reference: input.reference,
                        metadata: input.metadata,
                    }),
                });
            }
            catch {
                throw new PaymentProviderError(0, "paystack is unreachable");
            }
            const body = (await response.json().catch(() => ({})));
            if (!response.ok || body.status !== true) {
                throw new PaymentProviderError(response.status, body.message ?? `paystack rejected the transaction (HTTP ${response.status})`, response.status === 401 ? "INVALID_API_KEY" : undefined);
            }
            const { authorization_url: authorizationUrl, access_code: accessCode } = body.data ?? {};
            if (typeof authorizationUrl !== "string") {
                throw new PaymentProviderError(502, "paystack response was missing the authorization data");
            }
            return { reference: input.reference, authorizationUrl, accessCode };
        },
        async createRecurringSubscription(input) {
            const data = await request("/subscription", {
                method: "POST",
                body: {
                    customer: input.customer,
                    plan: input.planCode,
                    ...(input.startDate !== undefined ? { start_date: input.startDate } : {}),
                },
            });
            if (typeof data.subscription_code !== "string" ||
                typeof data.email_token !== "string" ||
                data.subscription_code.length === 0 ||
                data.email_token.length === 0) {
                throw new PaymentProviderError(502, "paystack response was missing the subscription data");
            }
            return { subscriptionCode: data.subscription_code, emailToken: data.email_token };
        },
        async disableRecurringSubscription(input) {
            let response;
            try {
                response = await fetchFn(`${apiBase}/subscription/disable`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${options.secretKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ code: input.subscriptionCode, token: input.emailToken }),
                });
            }
            catch {
                throw new PaymentProviderError(0, "paystack is unreachable");
            }
            const body = (await response.json().catch(() => ({})));
            if (!response.ok || body.status !== true) {
                throw new PaymentProviderError(response.status, body.message ?? `paystack rejected the request (HTTP ${response.status})`, response.status === 401 ? "INVALID_API_KEY" : undefined);
            }
        },
    };
}
/**
 * Converts an integer kobo string to a decimal naira string using string
 * math only ("150000" -> "1500.00"). Mirror of amountToKobo.
 */
export function koboToNaira(amount) {
    const normalized = amount.trim();
    if (!/^\d+$/.test(normalized)) {
        throw new Error(`invalid amount: ${amount}`);
    }
    const kobo = Number.parseInt(normalized, 10);
    return `${Math.floor(kobo / 100)}.${String(kobo % 100).padStart(2, "0")}`;
}
/**
 * Converts a decimal-string naira amount to integer kobo using string
 * math only — floats cannot represent 0.1 exactly, and payment amounts
 * must be exact integers.
 */
export function amountToKobo(amount) {
    const normalized = amount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
        throw new Error(`invalid amount: ${amount}`);
    }
    const [nairaRaw, koboPart = ""] = normalized.split(".");
    const naira = nairaRaw;
    const kobo = koboPart.padEnd(2, "0");
    return `${Number.parseInt(naira, 10) * 100 + Number.parseInt(kobo.padStart(2, "0"), 10)}`;
}
//# sourceMappingURL=paystack.js.map