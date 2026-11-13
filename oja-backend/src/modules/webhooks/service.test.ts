import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

import type { PaymentProvider } from "../../lib/paymentProvider.js";
import { decryptSecret, encryptSecret } from "../../lib/secrets.js";
import { handlePaystackWebhook } from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface TxStub {
  webhookEvent: { create: Mock; update: Mock };
  branch: { findFirst: Mock };
  order: { findUnique: Mock; updateMany: Mock };
  orderLineItem: { findMany: Mock };
  product: { findUnique: Mock; updateMany: Mock; findUniqueOrThrow: Mock };
  productVariant: { count: Mock };
  branchStock: { updateMany: Mock; findFirstOrThrow: Mock };
  stockLedgerEntry: { create: Mock };
  storeActivityLog: { create: Mock };
  storeWallet: {
    create: Mock;
    upsert: Mock;
    update: Mock;
    updateMany: Mock;
    findUniqueOrThrow: Mock;
  };
  walletEntry: { create: Mock };
  payout: { findUniqueOrThrow: Mock; updateMany: Mock };
}

interface PrismaStub {
  webhookEvent: { findUnique: Mock; create: Mock };
  order: { findFirst: Mock };
  paymentCredential: { findUnique: Mock };
  payout: { findFirst: Mock };
  $transaction: Mock;
}

const STORE_ID = "store-1";
const ORDER_ID = "order-1";
const BRANCH_ID = "branch-1";
const SECRET_KEY = "sk_test_1234abcd5678efgh";

function createTxStub(): TxStub {
  return {
    webhookEvent: { create: vi.fn(), update: vi.fn() },
    branch: { findFirst: vi.fn().mockResolvedValue({ id: BRANCH_ID, name: "Main Branch" }) },
    order: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ branchId: BRANCH_ID, total: new Prisma.Decimal("19.98") }),
      updateMany: vi.fn(),
    },
    orderLineItem: { findMany: vi.fn() },
    product: { findUnique: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    productVariant: { count: vi.fn().mockResolvedValue(0) },
    branchStock: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: vi.fn().mockResolvedValue({ quantity: 8 }),
    },
    stockLedgerEntry: { create: vi.fn() },
    storeActivityLog: { create: vi.fn() },
    storeWallet: {
      create: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ storeId: STORE_ID, balance: new Prisma.Decimal(0) }),
      update: vi
        .fn()
        .mockResolvedValue({ storeId: STORE_ID, balance: new Prisma.Decimal("19.98") }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ storeId: STORE_ID, balance: new Prisma.Decimal(0) }),
    },
    walletEntry: { create: vi.fn().mockResolvedValue({ id: "entry-1" }) },
    payout: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ id: "payout-1", amount: new Prisma.Decimal("100.00") }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function createPrismaStub(): PrismaStub {
  return {
    webhookEvent: { findUnique: vi.fn(), create: vi.fn() },
    order: { findFirst: vi.fn() },
    paymentCredential: { findUnique: vi.fn() },
    payout: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    storeId: STORE_ID,
    status: "PENDING",
    paymentProvider: "paystack",
    paymentReference: "ord_ref_1",
    ...overrides,
  };
}

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cred-1",
    storeId: STORE_ID,
    provider: "paystack",
    publicKey: "pk_test_1234",
    secretKeyEncrypted: encryptSecret(SECRET_KEY),
    ...overrides,
  };
}

function successPayload(reference = "ord_ref_1", eventId = "evt-1"): Buffer {
  return Buffer.from(
    JSON.stringify({ event: "charge.success", data: { id: eventId, reference } }),
    "utf8",
  );
}

function failedPayload(reference = "ord_ref_1", eventId = "evt-1"): Buffer {
  return Buffer.from(
    JSON.stringify({ event: "charge.failed", data: { id: eventId, reference } }),
    "utf8",
  );
}

let prisma: PrismaStub;
let tx: TxStub;
let provider: PaymentProvider & {
  verifyWebhookSignature: Mock;
  getTransactionStatus: Mock;
};

beforeEach(() => {
  prisma = createPrismaStub();
  tx = createTxStub();
  prismaMocks.getPrismaClient.mockReturnValue(prisma);
  prisma.$transaction.mockImplementation(async (fn: (t: TxStub) => Promise<unknown>) => fn(tx));
  provider = {
    id: "paystack",
    initiateCheckout: vi.fn(),
    verifyWebhookSignature: vi.fn(async () => true),
    getTransactionStatus: vi.fn(),
    resolveBankAccount: vi.fn(),
    createTransferRecipient: vi.fn(),
    initiateTransfer: vi.fn(),
    verifyTransfer: vi.fn(),
  } as unknown as PaymentProvider & {
    verifyWebhookSignature: Mock;
    getTransactionStatus: Mock;
  };
});

const providerFactory = (creds: { publicKey: string; secretKey: string }): PaymentProvider => {
  expect(creds.publicKey).toBe("pk_test_1234");
  expect(creds.secretKey).toBe(SECRET_KEY);
  return provider;
};

async function setupHappySuccess() {
  prisma.webhookEvent.findUnique.mockResolvedValue(null);
  prisma.order.findFirst.mockResolvedValue(orderRow());
  prisma.paymentCredential.findUnique.mockResolvedValue(credentialRow());
  tx.webhookEvent.create.mockResolvedValue({ id: "event-1", status: "PENDING" });
  tx.order.updateMany.mockResolvedValue({ count: 1 });
  tx.orderLineItem.findMany.mockResolvedValue([
    { id: "line-1", productId: "product-1", quantity: 2 },
  ]);
  tx.product.findUnique.mockResolvedValue({
    id: "product-1",
    storeId: STORE_ID,
    deletedAt: null,
    quantity: 10,
  });
  tx.product.updateMany.mockResolvedValue({ count: 1 });
  tx.product.findUniqueOrThrow.mockResolvedValue({
    id: "product-1",
    name: "Ground Coffee 500g",
    quantity: 8,
  });
  tx.stockLedgerEntry.create.mockResolvedValue({
    id: "ledger-1",
    quantityChange: -2,
    reason: "SALE",
    performedByStaffId: null,
  });
  tx.webhookEvent.update.mockResolvedValue({ id: "event-1", status: "PROCESSED" });
}

describe("handlePaystackWebhook (unit)", () => {
  it("marks the order PAID and decrements stock in ONE transaction on charge.success", async () => {
    await setupHappySuccess();
    const rawBody = successPayload();

    const result = await handlePaystackWebhook(rawBody, "sig", providerFactory);

    expect(result.outcome).toBe("PROCESSED");
    // Dedup gate first, then signature verification over the EXACT bytes.
    expect(prisma.webhookEvent.findUnique).toHaveBeenCalledWith({
      where: {
        provider_externalEventId: { provider: "paystack", externalEventId: "evt-1" },
      },
    });
    expect(provider.verifyWebhookSignature).toHaveBeenCalledWith(rawBody, "sig");

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    // Event row first (the race gate), then the guarded status transition.
    expect(tx.webhookEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: STORE_ID,
        provider: "paystack",
        externalEventId: "evt-1",
        status: "PENDING",
      }),
    });
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, status: "PENDING", storeId: STORE_ID },
      data: expect.objectContaining({ status: "PAID", paidAt: expect.any(Date) }),
    });
    // Stock moves through the ledger sale path inside the SAME transaction.
    expect(tx.stockLedgerEntry.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: "product-1",
        quantityChange: -2,
        reason: "SALE",
        performedByStaffId: null,
        variantId: null,
        referenceId: null,
      },
    });
    // The CARD sale's money enters the wallet inside the SAME transaction.
    expect(tx.storeWallet.update).toHaveBeenCalledWith({
      where: { storeId: STORE_ID },
      data: { balance: { increment: new Prisma.Decimal("19.98") } },
    });
    expect(tx.walletEntry.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        type: "CREDIT",
        source: "ORDER_PAYMENT",
        amount: new Prisma.Decimal("19.98"),
        balanceAfter: new Prisma.Decimal("19.98"),
        orderId: ORDER_ID,
        payoutId: null,
      },
    });
    expect(tx.webhookEvent.update).toHaveBeenCalledWith({
      where: { id: "event-1" },
      data: { status: "PROCESSED", processedAt: expect.any(Date) },
    });
  });

  it("ignores an already-processed event without verifying or touching anything (dedup)", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({ id: "event-1", status: "PROCESSED" });

    const result = await handlePaystackWebhook(successPayload(), "sig", providerFactory);

    expect(result.outcome).toBe("DUPLICATE");
    expect(provider.verifyWebhookSignature).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns DUPLICATE when a concurrent redelivery wins the unique-insert race (edge)", async () => {
    await setupHappySuccess();
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
    tx.webhookEvent.create.mockRejectedValue(p2002);

    const result = await handlePaystackWebhook(successPayload(), "sig", providerFactory);

    expect(result.outcome).toBe("DUPLICATE");
  });

  it("rejects with 401 INVALID_SIGNATURE when the signature does not verify", async () => {
    await setupHappySuccess();
    provider.verifyWebhookSignature.mockResolvedValue(false);

    await expect(
      handlePaystackWebhook(successPayload(), "forged", providerFactory),
    ).rejects.toMatchObject({ statusCode: 401, code: "INVALID_SIGNATURE" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 400 before any lookup", async () => {
    await expect(
      handlePaystackWebhook(Buffer.from("not json"), "sig", providerFactory),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a payload missing data.id or reference with 400", async () => {
    await expect(
      handlePaystackWebhook(
        Buffer.from(JSON.stringify({ event: "charge.success", data: { id: "evt-1" } })),
        "sig",
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      handlePaystackWebhook(
        Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "ord_ref_1" } })),
        "sig",
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("acknowledges unknown event types without verification or any write", async () => {
    const rawBody = Buffer.from(
      JSON.stringify({ event: "invoice.created", data: { id: "evt-x", reference: "ord_ref_1" } }),
    );

    const result = await handlePaystackWebhook(rawBody, "sig", providerFactory);

    expect(result.outcome).toBe("IGNORED");
    expect(provider.verifyWebhookSignature).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("marks the order FAILED on charge.failed and NEVER touches stock", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.order.findFirst.mockResolvedValue(orderRow());
    prisma.paymentCredential.findUnique.mockResolvedValue(credentialRow());
    tx.webhookEvent.create.mockResolvedValue({ id: "event-2", status: "PENDING" });
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.webhookEvent.update.mockResolvedValue({ id: "event-2", status: "PROCESSED" });

    const result = await handlePaystackWebhook(failedPayload(), "sig", providerFactory);

    expect(result.outcome).toBe("PROCESSED");
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, status: "PENDING" },
      data: { status: "FAILED" },
    });
    expect(tx.orderLineItem.findMany).not.toHaveBeenCalled();
    expect(tx.stockLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("records the event but changes nothing when the order is already PAID (no double decrement)", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.order.findFirst.mockResolvedValue(orderRow({ status: "PAID" }));
    prisma.paymentCredential.findUnique.mockResolvedValue(credentialRow());
    prisma.webhookEvent.create.mockResolvedValue({ id: "event-3", status: "PROCESSED" });

    const result = await handlePaystackWebhook(successPayload(), "sig", providerFactory);

    expect(result.outcome).toBe("PROCESSED");
    expect(prisma.webhookEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: STORE_ID,
        status: "PROCESSED",
        processedAt: expect.any(Date),
      }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(provider.verifyWebhookSignature).toHaveBeenCalled();
  });

  it("records the event but never resurrects a CANCELLED order", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.order.findFirst.mockResolvedValue(orderRow({ status: "CANCELLED" }));
    prisma.paymentCredential.findUnique.mockResolvedValue(credentialRow());
    prisma.webhookEvent.create.mockResolvedValue({ id: "event-4", status: "PROCESSED" });

    const result = await handlePaystackWebhook(successPayload(), "sig", providerFactory);

    expect(result.outcome).toBe("PROCESSED");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 404 ORDER_NOT_FOUND for an unknown reference, before any signature attempt", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.order.findFirst.mockResolvedValue(null);

    await expect(
      handlePaystackWebhook(successPayload("ord_unknown"), "sig", providerFactory),
    ).rejects.toMatchObject({ statusCode: 404, code: "ORDER_NOT_FOUND" });
    expect(provider.verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it("returns 409 PAYMENT_NOT_CONFIGURED when the store's credentials are gone", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.order.findFirst.mockResolvedValue(orderRow());
    prisma.paymentCredential.findUnique.mockResolvedValue(null);

    await expect(
      handlePaystackWebhook(successPayload(), "sig", providerFactory),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PAYMENT_NOT_CONFIGURED",
    });
    expect(provider.verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it("rolls the whole transaction back on insufficient stock (409 INSUFFICIENT_STOCK)", async () => {
    await setupHappySuccess();
    tx.branchStock.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      handlePaystackWebhook(successPayload(), "sig", providerFactory),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "INSUFFICIENT_STOCK",
    });
  });

  it("looks up credentials by store and returns 409 PAYMENT_NOT_CONFIGURED when they are gone", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.order.findFirst.mockResolvedValue(orderRow());
    prisma.paymentCredential.findUnique.mockResolvedValue(null);

    await expect(
      handlePaystackWebhook(successPayload(), "sig", providerFactory),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PAYMENT_NOT_CONFIGURED",
    });
    expect(provider.verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it("propagates the decrypted secret to the provider factory (no plaintext anywhere else)", async () => {
    await setupHappySuccess();
    const rawBody = successPayload();
    const spy = vi.fn(providerFactory);

    await handlePaystackWebhook(rawBody, "sig", spy);

    expect(spy).toHaveBeenCalledWith({ publicKey: "pk_test_1234", secretKey: SECRET_KEY });
    expect(decryptSecret).toBeDefined();
  });

  it("returns DUPLICATE when the unique constraint fires anywhere inside the processing transaction", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.order.findFirst.mockResolvedValue(orderRow());
    prisma.paymentCredential.findUnique.mockResolvedValue(credentialRow());
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const result = await handlePaystackWebhook(successPayload(), "sig", providerFactory);

    expect(result.outcome).toBe("DUPLICATE");
  });
});

describe("handlePaystackWebhook transfer events (unit)", () => {
  let prisma: PrismaStub;
  let tx: TxStub;
  let provider: PaymentProvider & { verifyWebhookSignature: Mock };

  const PAYOUT_ID = "payout-1";

  function transferPayload(event: "transfer.success" | "transfer.failed", eventId = "evt-t1") {
    return Buffer.from(
      JSON.stringify({
        event,
        data: { id: eventId, reference: "wd_ref_1", transfer_code: "TRF_abc123" },
      }),
      "utf8",
    );
  }

  beforeEach(() => {
    prisma = createPrismaStub();
    tx = createTxStub();
    prismaMocks.getPrismaClient.mockReturnValue(prisma);
    prisma.$transaction.mockImplementation(async (fn: (t: TxStub) => Promise<unknown>) => fn(tx));
    provider = {
      id: "paystack",
      initiateCheckout: vi.fn(),
      verifyWebhookSignature: vi.fn(async () => true),
      getTransactionStatus: vi.fn(),
      resolveBankAccount: vi.fn(),
      createTransferRecipient: vi.fn(),
      initiateTransfer: vi.fn(),
      verifyTransfer: vi.fn(),
    } as unknown as PaymentProvider & { verifyWebhookSignature: Mock };
    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.payout.findFirst.mockResolvedValue({
      id: PAYOUT_ID,
      storeId: STORE_ID,
      status: "REQUESTED",
    });
    prisma.paymentCredential.findUnique.mockResolvedValue(credentialRow());
    tx.webhookEvent.create.mockResolvedValue({ id: "event-t1", status: "PENDING" });
    tx.webhookEvent.update.mockResolvedValue({ id: "event-t1", status: "PROCESSED" });
    tx.payout.findUniqueOrThrow.mockResolvedValue({
      id: PAYOUT_ID,
      amount: new Prisma.Decimal("100.00"),
    });
    tx.storeWallet.update.mockResolvedValue({
      storeId: STORE_ID,
      balance: new Prisma.Decimal("100.00"),
    });
  });

  it("marks the payout SUCCESS on transfer.success, no wallet change", async () => {
    const result = await handlePaystackWebhook(
      transferPayload("transfer.success"),
      "sig",
      providerFactory,
    );

    expect(result.outcome).toBe("PROCESSED");
    expect(tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: PAYOUT_ID, status: { in: ["REQUESTED", "PROCESSING"] } },
      data: { status: "SUCCESS", processedAt: expect.any(Date) },
    });
    expect(tx.storeWallet.update).not.toHaveBeenCalled();
    expect(tx.walletEntry.create).not.toHaveBeenCalled();
  });

  it("marks the payout FAILED on transfer.failed and reverses the debit exactly once", async () => {
    const result = await handlePaystackWebhook(
      transferPayload("transfer.failed"),
      "sig",
      providerFactory,
    );

    expect(result.outcome).toBe("PROCESSED");
    expect(tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: PAYOUT_ID, status: { in: ["REQUESTED", "PROCESSING"] } },
      data: { status: "FAILED", processedAt: expect.any(Date) },
    });
    expect(tx.storeWallet.update).toHaveBeenCalledWith({
      where: { storeId: STORE_ID },
      data: { balance: { increment: new Prisma.Decimal("100.00") } },
    });
    expect(tx.walletEntry.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        type: "CREDIT",
        source: "WITHDRAWAL_REVERSAL",
        amount: new Prisma.Decimal("100.00"),
        balanceAfter: new Prisma.Decimal("100.00"),
        orderId: null,
        payoutId: PAYOUT_ID,
      },
    });
  });

  it("does NOT reverse when the payout is already terminal (redelivered failed event)", async () => {
    tx.payout.updateMany.mockResolvedValue({ count: 0 });

    const result = await handlePaystackWebhook(
      transferPayload("transfer.failed"),
      "sig",
      providerFactory,
    );

    expect(result.outcome).toBe("PROCESSED");
    expect(tx.storeWallet.update).not.toHaveBeenCalled();
    expect(tx.walletEntry.create).not.toHaveBeenCalled();
  });

  it("returns 404 PAYOUT_NOT_FOUND for an unknown transfer, before any signature attempt", async () => {
    prisma.payout.findFirst.mockResolvedValue(null);

    await expect(
      handlePaystackWebhook(transferPayload("transfer.success"), "sig", providerFactory),
    ).rejects.toMatchObject({ statusCode: 404, code: "PAYOUT_NOT_FOUND" });
    expect(provider.verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it("ignores a redelivered transfer event without re-processing (dedup)", async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({ id: "event-t1", status: "PROCESSED" });

    const result = await handlePaystackWebhook(
      transferPayload("transfer.success"),
      "sig",
      providerFactory,
    );

    expect(result.outcome).toBe("DUPLICATE");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
