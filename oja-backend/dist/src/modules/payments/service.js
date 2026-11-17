import { AppError } from "../../lib/AppError.js";
import { PaymentProviderError } from "../../lib/paymentProvider.js";
import { createPaystackProvider } from "../../lib/providers/paystack.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { decryptSecret, encryptSecret } from "../../lib/secrets.js";
import { setPaymentProviderSchema, validateOrThrow, } from "./schemas.js";
/**
 * Payment settings service: stores a merchant's bring-your-own-keys and
 * returns the masked view of them. The secret key is encrypted at rest
 * with the platform master key (lib/secrets.ts, AES-256-GCM) and the
 * encrypted payload is all that ever touches the database — the
 * plaintext lives only in the request body and, decrypted, in the
 * checkout service's memory while initiating a payment. No response
 * ever contains the full secret; GET returns `secretKeyMasked`.
 */
/**
 * Reduces a secret key to a masked indicator: first 6 chars + last 4,
 * middle replaced. Short keys are masked entirely after the prefix.
 */
export function maskSecretKey(secretKey) {
    if (secretKey.length <= 10) {
        return `${secretKey.slice(0, 4)}••••`;
    }
    return `${secretKey.slice(0, 6)}••••${secretKey.slice(-4)}`;
}
function toView(row, provider) {
    if (row === null) {
        return {
            configured: false,
            provider: provider,
            publicKey: null,
            secretKeyMasked: null,
            updatedAt: null,
        };
    }
    return {
        configured: true,
        provider: row.provider,
        publicKey: row.publicKey,
        secretKeyMasked: maskSecretKey(decryptSecret(row.secretKeyEncrypted)),
        updatedAt: row.updatedAt,
    };
}
/** GET the store's payment settings (masked; the secret is never exposed). */
export async function getPaymentProviderSettings(storeId) {
    const prisma = getPrismaClient();
    const row = await prisma.paymentCredential.findUnique({
        where: { storeId_provider: { storeId, provider: "paystack" } },
    });
    return toView(row, "paystack");
}
/** PUT/upsert the store's Paystack keys; the secret is encrypted at rest. */
export async function setPaymentProviderSettings(storeId, input) {
    const data = validateOrThrow(setPaymentProviderSchema, input);
    const prisma = getPrismaClient();
    const secretKeyEncrypted = encryptSecret(data.secretKey);
    const row = await prisma.paymentCredential.upsert({
        where: { storeId_provider: { storeId, provider: data.provider } },
        update: { publicKey: data.publicKey, secretKeyEncrypted },
        create: {
            storeId,
            provider: data.provider,
            publicKey: data.publicKey,
            secretKeyEncrypted,
        },
    });
    return toView(row, data.provider);
}
const defaultProviderFactory = ({ publicKey, secretKey }) => createPaystackProvider({ publicKey, secretKey });
function unavailableSettlement(detail) {
    return { status: "UNAVAILABLE", settledAt: null, detail };
}
/** Explicit explanation per Paystack transaction status. */
function settlementDetail(status) {
    switch (status) {
        case "success":
            return "Paystack does not expose per-transaction settlement data; batch settlement is tracked separately";
        case "failed":
            return "Transaction failed on Paystack; nothing to settle";
        case "pending":
            return "Transaction is still pending on Paystack; settlement state is not yet available";
        default:
            return "Unexpected transaction status from Paystack; settlement state is not available";
    }
}
async function toSettlementView(order, currency, credential, providerFactory) {
    const base = {
        orderId: order.id,
        reference: order.paymentReference ?? "",
        total: order.total.toString(),
        currency,
    };
    if (credential === null) {
        return {
            ...base,
            transactionStatus: "unavailable",
            paidAt: null,
            settlement: unavailableSettlement("No payment credentials configured for this store"),
        };
    }
    const provider = providerFactory({
        publicKey: credential.publicKey,
        secretKey: decryptSecret(credential.secretKeyEncrypted),
    });
    try {
        const status = await provider.getTransactionStatus(base.reference);
        return {
            ...base,
            transactionStatus: status.status,
            paidAt: status.paidAt,
            settlement: unavailableSettlement(settlementDetail(status.status)),
        };
    }
    catch (err) {
        if (err instanceof PaymentProviderError) {
            return {
                ...base,
                transactionStatus: "unavailable",
                paidAt: null,
                settlement: unavailableSettlement(`Paystack data unavailable: ${err.message}`),
            };
        }
        throw err;
    }
}
/**
 * Settlement status per paid order, queried live from the provider with
 * the store's own keys. Only the tenant's PAID orders are included,
 * newest first. Provider failures are reflected explicitly per order —
 * the endpoint itself never fails because Paystack is down.
 */
export async function getSettlementStatuses(storeId, providerFactory = defaultProviderFactory) {
    const prisma = getPrismaClient();
    const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { currency: true },
    });
    if (store === null) {
        throw new AppError(404, "NOT_FOUND", "Store not found");
    }
    const orders = await prisma.order.findMany({
        where: { storeId, status: "PAID" },
        orderBy: { createdAt: "desc" },
        select: { id: true, paymentReference: true, total: true },
    });
    if (orders.length === 0) {
        return [];
    }
    const credential = await prisma.paymentCredential.findUnique({
        where: { storeId_provider: { storeId, provider: "paystack" } },
    });
    const views = [];
    for (const order of orders) {
        views.push(await toSettlementView(order, store.currency, credential, providerFactory));
    }
    return views;
}
//# sourceMappingURL=service.js.map