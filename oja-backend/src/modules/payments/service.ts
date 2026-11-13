import { AppError } from "../../lib/AppError.js";
import type { ProviderFactory, TransactionStatus } from "../../lib/paymentProvider.js";
import { PaymentProviderError } from "../../lib/paymentProvider.js";
import { createPaystackProvider } from "../../lib/providers/paystack.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { decryptSecret, encryptSecret } from "../../lib/secrets.js";
import {
  setPaymentProviderSchema,
  validateOrThrow,
  type PaymentProviderSettingsView,
} from "./schemas.js";

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
export function maskSecretKey(secretKey: string): string {
  if (secretKey.length <= 10) {
    return `${secretKey.slice(0, 4)}••••`;
  }
  return `${secretKey.slice(0, 6)}••••${secretKey.slice(-4)}`;
}

function toView(
  row: { provider: string; publicKey: string; secretKeyEncrypted: string; updatedAt: Date } | null,
  provider: string,
): PaymentProviderSettingsView {
  if (row === null) {
    return {
      configured: false,
      provider: provider as PaymentProviderSettingsView["provider"],
      publicKey: null,
      secretKeyMasked: null,
      updatedAt: null,
    };
  }
  return {
    configured: true,
    provider: row.provider as PaymentProviderSettingsView["provider"],
    publicKey: row.publicKey,
    secretKeyMasked: maskSecretKey(decryptSecret(row.secretKeyEncrypted)),
    updatedAt: row.updatedAt,
  };
}

/** GET the store's payment settings (masked; the secret is never exposed). */
export async function getPaymentProviderSettings(
  storeId: string,
): Promise<PaymentProviderSettingsView> {
  const prisma = getPrismaClient();
  const row = await prisma.paymentCredential.findUnique({
    where: { storeId_provider: { storeId, provider: "paystack" } },
  });
  return toView(row, "paystack");
}

/** PUT/upsert the store's Paystack keys; the secret is encrypted at rest. */
export async function setPaymentProviderSettings(
  storeId: string,
  input: unknown,
): Promise<PaymentProviderSettingsView> {
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

/**
 * Per-paid-order settlement state for the settlement-status endpoint.
 * Every field is present — when Paystack's data is unavailable the view
 * says so explicitly (contract: never omit the settlement field).
 * Timestamps are UTC ISO-8601.
 */
export interface SettlementView {
  orderId: string;
  reference: string;
  total: string;
  currency: string;
  transactionStatus: TransactionStatus["status"] | "unavailable";
  paidAt: string | null;
  settlement: {
    status: "SETTLED" | "UNAVAILABLE";
    settledAt: string | null;
    detail: string | null;
  };
}

const defaultProviderFactory: ProviderFactory = ({ publicKey, secretKey }) =>
  createPaystackProvider({ publicKey, secretKey });

function unavailableSettlement(detail: string): SettlementView["settlement"] {
  return { status: "UNAVAILABLE", settledAt: null, detail };
}

/** Explicit explanation per Paystack transaction status. */
function settlementDetail(status: TransactionStatus["status"]): string {
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

async function toSettlementView(
  order: { id: string; paymentReference: string | null; total: { toString(): string } },
  currency: string,
  credential: { publicKey: string; secretKeyEncrypted: string } | null,
  providerFactory: ProviderFactory,
): Promise<SettlementView> {
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
  } catch (err) {
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
export async function getSettlementStatuses(
  storeId: string,
  providerFactory: ProviderFactory = defaultProviderFactory,
): Promise<SettlementView[]> {
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

  const views: SettlementView[] = [];
  for (const order of orders) {
    views.push(await toSettlementView(order, store.currency, credential, providerFactory));
  }
  return views;
}
