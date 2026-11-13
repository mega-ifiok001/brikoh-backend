import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

import { decryptSecret, encryptSecret } from "../../lib/secrets.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { PaymentProvider } from "../../lib/paymentProvider.js";
import { PaymentProviderError } from "../../lib/paymentProvider.js";
import {
  getPaymentProviderSettings,
  getSettlementStatuses,
  maskSecretKey,
  setPaymentProviderSettings,
} from "./service.js";
import type { PaymentProviderSettingsView } from "./schemas.js";
import { setPaymentProviderSchema } from "./schemas.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  paymentCredential: {
    findUnique: Mock;
    upsert: Mock;
  };
  store: { findUnique: Mock };
  order: { findMany: Mock };
}

const STORE_ID = "store-1";
const PUBLIC_KEY = "pk_test_1234abcd";
const SECRET_KEY = "sk_test_1234abcd5678efgh";

function createPrismaStub(): PrismaStub {
  return {
    paymentCredential: { findUnique: vi.fn(), upsert: vi.fn() },
    store: { findUnique: vi.fn() },
    order: { findMany: vi.fn() },
  };
}

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cred-1",
    storeId: STORE_ID,
    provider: "paystack",
    publicKey: PUBLIC_KEY,
    secretKeyEncrypted: encryptSecret(SECRET_KEY),
    createdAt: new Date("2026-08-03T12:00:00Z"),
    updatedAt: new Date("2026-08-03T12:00:00Z"),
    ...overrides,
  };
}

let prisma: PrismaStub;

beforeEach(() => {
  prisma = createPrismaStub();
  prismaMocks.getPrismaClient.mockReturnValue(prisma);
});

describe("maskSecretKey (unit)", () => {
  it("shows only the first 6 and last 4 characters", () => {
    expect(maskSecretKey(SECRET_KEY)).toBe("sk_tes••••efgh");
  });

  it("never leaks the middle of the secret (edge)", () => {
    const masked = maskSecretKey(SECRET_KEY);

    expect(masked).not.toContain("1234abcd");
    expect(masked).not.toBe(SECRET_KEY);
  });

  it("handles a very short key by masking everything after the 4-char prefix (edge)", () => {
    expect(maskSecretKey("sk_ab")).toBe("sk_a••••");
  });
});

describe("setPaymentProviderSettings (unit)", () => {
  it("encrypts the secret key at rest and upserts the credential", async () => {
    prisma.paymentCredential.upsert.mockResolvedValue(credentialRow());

    const result = await setPaymentProviderSettings(STORE_ID, {
      provider: "paystack",
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
    });

    const args = prisma.paymentCredential.upsert.mock.calls[0]![0] as {
      where: unknown;
      update: { publicKey: string; secretKeyEncrypted: string };
      create: { publicKey: string; secretKeyEncrypted: string };
    };
    expect(prisma.paymentCredential.upsert).toHaveBeenCalledTimes(1);
    expect(args.where).toEqual({
      storeId_provider: { storeId: STORE_ID, provider: "paystack" },
    });
    const encrypted = args.create.secretKeyEncrypted as string;
    expect(encrypted).not.toContain(SECRET_KEY);
    expect(decryptSecret(encrypted)).toBe(SECRET_KEY);
    expect(args.create.publicKey).toBe(PUBLIC_KEY);

    expect(result.publicKey).toBe(PUBLIC_KEY);
    expect(result.secretKeyMasked).not.toContain(SECRET_KEY);
  });

  it("replaces the previous pair on re-save (update path)", async () => {
    const newSecret = "sk_live_9999abcd5678efgh";
    prisma.paymentCredential.upsert.mockResolvedValue(
      credentialRow({
        publicKey: "pk_live_9999abcd",
        secretKeyEncrypted: encryptSecret(newSecret),
        updatedAt: new Date("2026-08-04T00:00:00Z"),
      }),
    );

    const result = await setPaymentProviderSettings(STORE_ID, {
      provider: "paystack",
      publicKey: "pk_live_9999abcd",
      secretKey: newSecret,
    });

    const args = prisma.paymentCredential.upsert.mock.calls[0]![0] as {
      update: { publicKey: string; secretKeyEncrypted: string };
      create: { publicKey: string; secretKeyEncrypted: string };
    };
    expect(args.update.secretKeyEncrypted).toBe(args.create.secretKeyEncrypted);
    expect(decryptSecret(args.update.secretKeyEncrypted)).toBe(newSecret);
    expect(result.secretKeyMasked).toBe(maskSecretKey(newSecret));
    expect(result.secretKeyMasked).not.toContain("9999");
    expect(result.updatedAt).toEqual(new Date("2026-08-04T00:00:00Z"));
  });

  it("returns a view that never contains the full secret (edge)", () => {
    const view: PaymentProviderSettingsView = {
      configured: true,
      provider: "paystack",
      publicKey: PUBLIC_KEY,
      secretKeyMasked: maskSecretKey(SECRET_KEY),
      updatedAt: new Date("2026-08-03T12:00:00Z"),
    };
    expect(JSON.stringify(view)).not.toContain(SECRET_KEY);
  });
});

describe("getPaymentProviderSettings (unit)", () => {
  it("returns the masked view when credentials exist", async () => {
    prisma.paymentCredential.findUnique.mockResolvedValue(credentialRow());

    const result = await getPaymentProviderSettings(STORE_ID);

    expect(result).toMatchObject({
      configured: true,
      provider: "paystack",
      publicKey: PUBLIC_KEY,
      secretKeyMasked: maskSecretKey(SECRET_KEY),
    });
    expect(JSON.stringify(result)).not.toContain("1234abcd5678efgh");
  });

  it("returns configured:false when the store has no credentials", async () => {
    prisma.paymentCredential.findUnique.mockResolvedValue(null);

    const result = await getPaymentProviderSettings(STORE_ID);

    expect(result).toEqual({
      configured: false,
      provider: "paystack",
      publicKey: null,
      secretKeyMasked: null,
      updatedAt: null,
    });
  });
});

describe("getSettlementStatuses (unit)", () => {
  function orderRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "order-1",
      paymentReference: "ord_ref_1",
      total: new Prisma.Decimal("19.98"),
      ...overrides,
    };
  }

  let provider: {
    getTransactionStatus: Mock;
    id: string;
    initiateCheckout: Mock;
    verifyWebhookSignature: Mock;
    resolveBankAccount: Mock;
    createTransferRecipient: Mock;
    initiateTransfer: Mock;
    verifyTransfer: Mock;
  };

  const providerFactory = (creds: { publicKey: string; secretKey: string }): PaymentProvider => {
    expect(creds.publicKey).toBe(PUBLIC_KEY);
    expect(creds.secretKey).toBe(SECRET_KEY);
    return provider as unknown as PaymentProvider;
  };

  beforeEach(() => {
    prisma.store.findUnique.mockResolvedValue({ id: STORE_ID, currency: "NGN" });
    prisma.order.findMany.mockResolvedValue([
      orderRow(),
      orderRow({ id: "order-2", paymentReference: "ord_ref_2", total: new Prisma.Decimal("5.00") }),
    ]);
    prisma.paymentCredential.findUnique.mockResolvedValue(credentialRow());
    provider = {
      id: "paystack",
      initiateCheckout: vi.fn(),
      verifyWebhookSignature: vi.fn(),
      getTransactionStatus: vi.fn(async () => ({
        status: "success",
        paidAt: "2026-08-04T09:47:36.001Z",
        amount: "19.98",
        currency: "NGN",
      })),
      resolveBankAccount: vi.fn(),
      createTransferRecipient: vi.fn(),
      initiateTransfer: vi.fn(),
      verifyTransfer: vi.fn(),
    };
  });

  it("queries ONLY the tenant's PAID orders, newest first, and reports live transaction state", async () => {
    const result = await getSettlementStatuses(STORE_ID, providerFactory);

    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: { storeId: STORE_ID, status: "PAID" },
      orderBy: { createdAt: "desc" },
      select: { id: true, paymentReference: true, total: true },
    });
    expect(provider.getTransactionStatus).toHaveBeenCalledTimes(2);
    expect(provider.getTransactionStatus).toHaveBeenCalledWith("ord_ref_1");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      orderId: "order-1",
      reference: "ord_ref_1",
      total: "19.98",
      currency: "NGN",
      transactionStatus: "success",
      paidAt: "2026-08-04T09:47:36.001Z",
      settlement: {
        status: "UNAVAILABLE",
        settledAt: null,
        detail: expect.stringContaining("Paystack"),
      },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
  });

  it("returns an empty list when the store has no paid orders (no provider call)", async () => {
    prisma.order.findMany.mockResolvedValue([]);

    const result = await getSettlementStatuses(STORE_ID, providerFactory);

    expect(result).toEqual([]);
    expect(prisma.paymentCredential.findUnique).not.toHaveBeenCalled();
  });

  it("maps failed/pending/unknown transaction statuses explicitly", async () => {
    const providerMock = vi.fn(async (reference: string) => ({
      status: reference === "ord_ref_1" ? "failed" : "pending",
      paidAt: null,
      amount: null,
      currency: null,
    }));
    provider.getTransactionStatus = providerMock;

    const result = await getSettlementStatuses(STORE_ID, providerFactory);

    expect(result[0]!.transactionStatus).toBe("failed");
    expect(result[0]!.paidAt).toBeNull();
    expect(result[0]!.settlement.detail).toContain("failed");
    expect(result[1]!.transactionStatus).toBe("pending");
    expect(result[1]!.settlement.detail).toContain("pending");
  });

  it("reports Paystack unavailability explicitly instead of failing the endpoint", async () => {
    provider.getTransactionStatus = vi.fn(async () => {
      throw new PaymentProviderError(0, "paystack is unreachable");
    });

    const result = await getSettlementStatuses(STORE_ID, providerFactory);

    expect(result[0]).toMatchObject({
      transactionStatus: "unavailable",
      paidAt: null,
      settlement: { status: "UNAVAILABLE", settledAt: null },
    });
    expect(result[0]!.settlement.detail).toContain("paystack is unreachable");
  });

  it("reports missing credentials explicitly when the store's keys were deleted", async () => {
    prisma.paymentCredential.findUnique.mockResolvedValue(null);

    const result = await getSettlementStatuses(STORE_ID, providerFactory);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      transactionStatus: "unavailable",
      settlement: { status: "UNAVAILABLE" },
    });
    expect(result[0]!.settlement.detail).toContain("credentials");
  });
});

describe("setPaymentProviderSchema (unit)", () => {
  it("accepts a valid paystack key pair", () => {
    const result = setPaymentProviderSchema.safeParse({
      provider: "paystack",
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown provider", () => {
    expect(
      setPaymentProviderSchema.safeParse({
        provider: "opay",
        publicKey: PUBLIC_KEY,
        secretKey: SECRET_KEY,
      }).success,
    ).toBe(false);
  });

  it("rejects key shapes that do not match the paystack prefix pattern", () => {
    expect(
      setPaymentProviderSchema.safeParse({
        provider: "paystack",
        publicKey: "wrong-key",
        secretKey: SECRET_KEY,
      }).success,
    ).toBe(false);
    expect(
      setPaymentProviderSchema.safeParse({
        provider: "paystack",
        publicKey: PUBLIC_KEY,
        secretKey: "sk_missing_mode_abc",
      }).success,
    ).toBe(false);
  });

  it("rejects when a key is missing", () => {
    const result = setPaymentProviderSchema.safeParse({
      provider: "paystack",
      publicKey: PUBLIC_KEY,
    });
    expect(result.success).toBe(false);
  });
});
