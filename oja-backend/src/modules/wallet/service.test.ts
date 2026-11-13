import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

import { Prisma } from "../../../generated/prisma/client.js";
import type { PaymentProvider } from "../../lib/paymentProvider.js";
import { PaymentProviderError } from "../../lib/paymentProvider.js";
import { encryptSecret } from "../../lib/secrets.js";
import {
  createBankAccount,
  createWithdrawal,
  creditWallet,
  deleteBankAccount,
  getWalletOverview,
  listBankAccounts,
  listWithdrawals,
  maskAccountNumber,
} from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface TxStub {
  bankAccount: { create: Mock; updateMany: Mock; delete: Mock };
  storeWallet: {
    create: Mock;
    upsert: Mock;
    update: Mock;
    updateMany: Mock;
    findUniqueOrThrow: Mock;
  };
  walletEntry: { create: Mock };
  payout: { create: Mock; updateMany: Mock };
  storeActivityLog: { create: Mock };
}

interface PrismaStub {
  paymentCredential: { findUnique: Mock };
  bankAccount: { findMany: Mock; findFirst: Mock };
  payout: {
    findMany: Mock;
    findFirst: Mock;
    findUniqueOrThrow: Mock;
    aggregate: Mock;
    updateMany: Mock;
  };
  storeWallet: { findUnique: Mock };
  walletEntry: { findMany: Mock; aggregate: Mock };
  $transaction: Mock;
}

const STORE_ID = "store-1";
const SECRET_KEY = "sk_test_1234abcd5678efgh";

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

function bankAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    storeId: STORE_ID,
    accountName: "JOHN DOE",
    bankName: "First Bank",
    bankCode: "011",
    maskedAccountNumber: "0123••••6789",
    recipientCode: "RCP_abc123",
    isDefault: true,
    createdAt: new Date("2026-08-10T10:00:00Z"),
    ...overrides,
  };
}

function payoutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    storeId: STORE_ID,
    bankAccountId: "11111111-1111-4111-8111-111111111111",
    reference: "wd_abc123",
    amount: new Prisma.Decimal("1500.00"),
    status: "REQUESTED",
    transferCode: null,
    createdAt: new Date("2026-08-10T11:00:00Z"),
    processedAt: null,
    bankAccount: {
      id: "11111111-1111-4111-8111-111111111111",
      maskedAccountNumber: "0123••••6789",
      bankName: "First Bank",
      accountName: "JOHN DOE",
    },
    ...overrides,
  };
}

function providerStub(): PaymentProvider {
  return {
    id: "paystack",
    initiateCheckout: vi.fn(),
    verifyWebhookSignature: vi.fn(),
    getTransactionStatus: vi.fn(),
    resolveBankAccount: vi.fn(),
    createTransferRecipient: vi.fn(),
    initiateTransfer: vi.fn(),
    verifyTransfer: vi.fn(),
  } as unknown as PaymentProvider;
}

function createTxStub(): TxStub {
  return {
    bankAccount: { create: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
    storeWallet: {
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn(),
    },
    walletEntry: { create: vi.fn() },
    payout: { create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    storeActivityLog: { create: vi.fn() },
  };
}

function createPrismaStub(): PrismaStub {
  return {
    paymentCredential: { findUnique: vi.fn() },
    bankAccount: { findMany: vi.fn(), findFirst: vi.fn() },
    payout: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      aggregate: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    storeWallet: { findUnique: vi.fn() },
    walletEntry: { findMany: vi.fn(), aggregate: vi.fn() },
    $transaction: vi.fn(),
  };
}

let prisma: PrismaStub;
let tx: TxStub;
let provider: PaymentProvider;

beforeEach(() => {
  prisma = createPrismaStub();
  tx = createTxStub();
  prismaMocks.getPrismaClient.mockReturnValue(prisma);
  prisma.$transaction.mockImplementation(async (fn: (t: TxStub) => Promise<unknown>) => fn(tx));
  prisma.paymentCredential.findUnique.mockResolvedValue(credentialRow());
  provider = providerStub();
});

const providerFactory = (): PaymentProvider => provider;

describe("maskAccountNumber (unit)", () => {
  it("shows only the first 4 and last 4 digits", () => {
    expect(maskAccountNumber("0123456789")).toBe("0123••••6789");
  });
});

describe("getWalletOverview (unit)", () => {
  it("reports live balance plus pending, withdrawn, and total credits sums", async () => {
    prisma.storeWallet.findUnique.mockResolvedValue({
      storeId: STORE_ID,
      balance: new Prisma.Decimal("500.00"),
    });
    prisma.payout.aggregate
      .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal("200.00") } })
      .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal("800.00") } });
    prisma.walletEntry.aggregate.mockResolvedValue({
      _sum: { amount: new Prisma.Decimal("1500.00") },
    });
    prisma.walletEntry.findMany.mockResolvedValue([
      {
        id: "entry-1",
        type: "CREDIT",
        source: "ORDER_PAYMENT",
        amount: new Prisma.Decimal("1500.00"),
        balanceAfter: new Prisma.Decimal("1500.00"),
        orderId: "order-1",
        payoutId: null,
        createdAt: new Date("2026-08-10T12:00:00Z"),
      },
    ]);

    const result = await getWalletOverview(STORE_ID);

    expect(result.wallet).toEqual({
      currency: "NGN",
      available: "500",
      pending: "200",
      withdrawn: "800",
      totalCredits: "1500",
    });
    expect(result.recentEntries).toHaveLength(1);
    expect(result.recentEntries[0]).toMatchObject({
      type: "CREDIT",
      source: "ORDER_PAYMENT",
      amount: "1500",
      balanceAfter: "1500",
      orderId: "order-1",
    });
  });

  it("treats a missing wallet and empty sums as zero", async () => {
    prisma.storeWallet.findUnique.mockResolvedValue(null);
    prisma.payout.aggregate
      .mockResolvedValueOnce({ _sum: { amount: null } })
      .mockResolvedValueOnce({ _sum: { amount: null } });
    prisma.walletEntry.aggregate.mockResolvedValue({ _sum: { amount: null } });
    prisma.walletEntry.findMany.mockResolvedValue([]);

    const result = await getWalletOverview(STORE_ID);

    expect(result.wallet.available).toBe("0");
    expect(result.wallet.pending).toBe("0");
    expect(result.wallet.withdrawn).toBe("0");
    expect(result.wallet.totalCredits).toBe("0");
  });
});

describe("listBankAccounts (unit)", () => {
  it("returns only the masked number — the raw account number never leaves the provider", async () => {
    prisma.bankAccount.findMany.mockResolvedValue([
      bankAccountRow({ isDefault: false }),
      bankAccountRow({ id: "22222222-2222-4222-8222-222222222222", isDefault: true }),
    ]);

    const result = await listBankAccounts(STORE_ID);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      accountName: "JOHN DOE",
      bankName: "First Bank",
      maskedAccountNumber: "0123••••6789",
      isDefault: false,
    });
    expect(result[0]).not.toHaveProperty("recipientCode");
    expect(result[1]!.isDefault).toBe(true);
  });
});

describe("createBankAccount (unit)", () => {
  it("resolves the account, creates a recipient, and stores only the masked number", async () => {
    (provider.resolveBankAccount as Mock).mockResolvedValue({ accountName: "JOHN DOE" });
    (provider.createTransferRecipient as Mock).mockResolvedValue({ recipientCode: "RCP_abc123" });
    tx.bankAccount.create.mockResolvedValue(bankAccountRow());

    const result = await createBankAccount(
      STORE_ID,
      {
        accountName: "JOHN DOE",
        bankName: "First Bank",
        bankCode: "011",
        accountNumber: "0123456789",
      },
      providerFactory,
    );

    expect(provider.resolveBankAccount).toHaveBeenCalledWith("011", "0123456789");
    expect(provider.createTransferRecipient).toHaveBeenCalledWith({
      name: "JOHN DOE",
      accountNumber: "0123456789",
      bankCode: "011",
    });
    expect(tx.bankAccount.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        accountName: "JOHN DOE",
        bankName: "First Bank",
        bankCode: "011",
        maskedAccountNumber: "0123••••6789",
        recipientCode: "RCP_abc123",
        isDefault: false,
      },
    });
    expect(result).toMatchObject({ maskedAccountNumber: "0123••••6789" });
  });

  it("rejects with 400 when the stated name does not match the resolved name", async () => {
    (provider.resolveBankAccount as Mock).mockResolvedValue({ accountName: "JANE SMITH" });

    await expect(
      createBankAccount(
        STORE_ID,
        {
          accountName: "JOHN DOE",
          bankName: "First Bank",
          bankCode: "011",
          accountNumber: "0123456789",
        },
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "BANK_ACCOUNT_UNRESOLVED" });
    expect(provider.createTransferRecipient).not.toHaveBeenCalled();
  });

  it("maps a provider rejection to 400 BANK_ACCOUNT_UNRESOLVED", async () => {
    (provider.resolveBankAccount as Mock).mockRejectedValue(
      new PaymentProviderError(422, "Account number does not match bank code"),
    );

    await expect(
      createBankAccount(
        STORE_ID,
        { bankName: "First Bank", bankCode: "011", accountNumber: "0000000000" },
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "BANK_ACCOUNT_UNRESOLVED" });
  });

  it("maps a recipient creation failure to 502 PAYMENT_PROVIDER_ERROR", async () => {
    (provider.resolveBankAccount as Mock).mockResolvedValue({ accountName: "JOHN DOE" });
    (provider.createTransferRecipient as Mock).mockRejectedValue(
      new PaymentProviderError(400, "Invalid bank code"),
    );

    await expect(
      createBankAccount(
        STORE_ID,
        { bankName: "First Bank", bankCode: "011", accountNumber: "0123456789" },
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 502, code: "PAYMENT_PROVIDER_ERROR" });
    expect(tx.bankAccount.create).not.toHaveBeenCalled();
  });

  it("rejects the request when the store has no payment credentials (409)", async () => {
    prisma.paymentCredential.findUnique.mockResolvedValue(null);

    await expect(
      createBankAccount(
        STORE_ID,
        { bankName: "First Bank", bankCode: "011", accountNumber: "0123456789" },
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "PAYMENT_NOT_CONFIGURED" });
  });
});

describe("deleteBankAccount (unit)", () => {
  it("deletes the account when it has no payout history", async () => {
    prisma.bankAccount.findFirst.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" });
    prisma.payout.findFirst.mockResolvedValue(null);

    await deleteBankAccount(STORE_ID, "11111111-1111-4111-8111-111111111111");

    expect(tx.bankAccount.delete).toHaveBeenCalledWith({
      where: { id: "11111111-1111-4111-8111-111111111111" },
    });
  });

  it("returns 404 for a foreign or unknown account", async () => {
    prisma.bankAccount.findFirst.mockResolvedValue(null);

    await expect(
      deleteBankAccount(STORE_ID, "99999999-9999-4999-8999-999999999999"),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "BANK_ACCOUNT_NOT_FOUND",
    });
  });

  it("returns 409 when the account has payout history (attribution must survive)", async () => {
    prisma.bankAccount.findFirst.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" });
    prisma.payout.findFirst.mockResolvedValue({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" });

    await expect(
      deleteBankAccount(STORE_ID, "11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "BANK_ACCOUNT_HAS_PAYOUTS",
    });
    expect(tx.bankAccount.delete).not.toHaveBeenCalled();
  });
});

describe("createWithdrawal (unit)", () => {
  it("debits the wallet and creates the payout in one transaction, then initiates the transfer", async () => {
    prisma.bankAccount.findFirst.mockResolvedValue(bankAccountRow());
    tx.storeWallet.findUniqueOrThrow.mockResolvedValue({
      storeId: STORE_ID,
      balance: new Prisma.Decimal("1350.00"),
    });
    tx.payout.create.mockResolvedValue(payoutRow());
    tx.payout.updateMany.mockResolvedValue({ count: 1 });
    (provider.initiateTransfer as Mock).mockResolvedValue({ transferCode: "TRF_xyz789" });
    prisma.payout.findUniqueOrThrow.mockResolvedValue(
      payoutRow({ status: "PROCESSING", transferCode: "TRF_xyz789" }),
    );

    const result = await createWithdrawal(
      STORE_ID,
      { bankAccountId: "11111111-1111-4111-8111-111111111111", amount: "1500.00" },
      providerFactory,
    );

    expect(tx.storeWallet.updateMany).toHaveBeenCalledWith({
      where: { storeId: STORE_ID, balance: { gte: new Prisma.Decimal("1500.00") } },
      data: { balance: { decrement: new Prisma.Decimal("1500.00") } },
    });
    expect(tx.payout.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        bankAccountId: "11111111-1111-4111-8111-111111111111",
        reference: expect.stringMatching(/^wd_[0-9a-f]{32}$/),
        amount: new Prisma.Decimal("1500.00"),
      },
    });
    expect(tx.walletEntry.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        type: "DEBIT",
        source: "WITHDRAWAL",
        amount: new Prisma.Decimal("1500.00"),
        balanceAfter: new Prisma.Decimal("1350.00"),
        payoutId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });
    expect(provider.initiateTransfer).toHaveBeenCalledWith({
      recipientCode: "RCP_abc123",
      amount: "1500",
      reference: expect.stringMatching(/^wd_/),
    });
    expect(prisma.payout.updateMany).toHaveBeenCalledWith({
      where: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "REQUESTED" },
      data: { status: "PROCESSING", transferCode: "TRF_xyz789" },
    });
    expect(result).toMatchObject({ status: "PROCESSING", amount: "1500" });
  });

  it("rejects amounts below the ₦100 minimum with 400", async () => {
    await expect(
      createWithdrawal(
        STORE_ID,
        { bankAccountId: "11111111-1111-4111-8111-111111111111", amount: "50.00" },
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "WITHDRAWAL_BELOW_MINIMUM" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an unknown bank account with 404 before any debit", async () => {
    prisma.bankAccount.findFirst.mockResolvedValue(null);

    await expect(
      createWithdrawal(
        STORE_ID,
        { bankAccountId: "99999999-9999-4999-8999-999999999999", amount: "1500.00" },
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "BANK_ACCOUNT_NOT_FOUND" });
    expect(tx.storeWallet.updateMany).not.toHaveBeenCalled();
  });

  it("rejects with 409 INSUFFICIENT_WALLET_BALANCE when the conditional decrement fails", async () => {
    prisma.bankAccount.findFirst.mockResolvedValue(bankAccountRow());
    tx.storeWallet.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      createWithdrawal(
        STORE_ID,
        { bankAccountId: "11111111-1111-4111-8111-111111111111", amount: "1500.00" },
        providerFactory,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "INSUFFICIENT_WALLET_BALANCE" });
    expect(tx.payout.create).not.toHaveBeenCalled();
    expect(provider.initiateTransfer).not.toHaveBeenCalled();
  });

  it("reverses the debit when the provider rejects the transfer (automatic reversal)", async () => {
    prisma.bankAccount.findFirst.mockResolvedValue(bankAccountRow());
    tx.storeWallet.findUniqueOrThrow.mockResolvedValue({
      storeId: STORE_ID,
      balance: new Prisma.Decimal("0.00"),
    });
    tx.payout.create.mockResolvedValue(payoutRow());
    (provider.initiateTransfer as Mock).mockRejectedValue(
      new PaymentProviderError(402, "Balance insufficient"),
    );
    tx.storeWallet.update.mockResolvedValue({
      storeId: STORE_ID,
      balance: new Prisma.Decimal("0.00"),
    });
    prisma.payout.findUniqueOrThrow.mockResolvedValue(payoutRow({ status: "FAILED" }));

    const result = await createWithdrawal(
      STORE_ID,
      { bankAccountId: "11111111-1111-4111-8111-111111111111", amount: "1500.00" },
      providerFactory,
    );

    expect(tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "REQUESTED" },
      data: { status: "FAILED", processedAt: expect.any(Date) },
    });
    expect(tx.storeWallet.update).toHaveBeenCalledWith({
      where: { storeId: STORE_ID },
      data: { balance: { increment: new Prisma.Decimal("1500.00") } },
    });
    expect(tx.walletEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "CREDIT",
        source: "WITHDRAWAL_REVERSAL",
        amount: new Prisma.Decimal("1500.00"),
        payoutId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    });
    expect(result.status).toBe("FAILED");
  });

  it("does NOT reverse twice when a concurrent webhook already marked the payout FAILED", async () => {
    prisma.bankAccount.findFirst.mockResolvedValue(bankAccountRow());
    tx.storeWallet.findUniqueOrThrow.mockResolvedValue({
      storeId: STORE_ID,
      balance: new Prisma.Decimal("0.00"),
    });
    tx.payout.create.mockResolvedValue(payoutRow());
    (provider.initiateTransfer as Mock).mockRejectedValue(
      new PaymentProviderError(402, "Balance insufficient"),
    );
    tx.payout.updateMany.mockResolvedValue({ count: 0 });
    prisma.payout.findUniqueOrThrow.mockResolvedValue(payoutRow({ status: "FAILED" }));

    const result = await createWithdrawal(
      STORE_ID,
      { bankAccountId: "11111111-1111-4111-8111-111111111111", amount: "1500.00" },
      providerFactory,
    );

    expect(tx.storeWallet.update).not.toHaveBeenCalled();
    expect(tx.walletEntry.create).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("FAILED");
  });
});

describe("listWithdrawals (unit)", () => {
  it("returns the page plus a next cursor when more rows exist", async () => {
    const rows = [
      payoutRow({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
      payoutRow({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      payoutRow({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    ];
    prisma.payout.findMany.mockResolvedValue(rows);
    prisma.payout.findMany.mockResolvedValueOnce([
      ...rows,
      payoutRow({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
    ]);

    const result = await listWithdrawals(STORE_ID, { limit: 3 });

    expect(prisma.payout.findMany).toHaveBeenCalledWith({
      where: { storeId: STORE_ID },
      orderBy: { createdAt: "desc" },
      take: 4,
      include: { bankAccount: true },
    });
    expect(result.items).toHaveLength(3);
    expect(result.nextCursor).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("supports cursor pagination and returns null when on the last page", async () => {
    prisma.payout.findMany.mockResolvedValue([
      payoutRow({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    ]);

    const result = await listWithdrawals(STORE_ID, {
      cursor: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      limit: 20,
    });

    expect(prisma.payout.findMany).toHaveBeenCalledWith({
      where: { storeId: STORE_ID, id: { lt: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
      orderBy: { createdAt: "desc" },
      take: 21,
      include: { bankAccount: true },
    });
    expect(result.nextCursor).toBeNull();
  });
});

describe("creditWallet (unit)", () => {
  it("appends a CREDIT entry with the exact post-increment balance", async () => {
    tx.storeWallet.update.mockResolvedValue({
      storeId: STORE_ID,
      balance: new Prisma.Decimal("200.00"),
    });

    await creditWallet(tx as unknown as Prisma.TransactionClient, STORE_ID, {
      amount: new Prisma.Decimal("200.00"),
      orderId: "order-9",
      source: "ORDER_PAYMENT",
    });

    expect(tx.storeWallet.upsert).toHaveBeenCalledWith({
      where: { storeId: STORE_ID },
      update: {},
      create: { storeId: STORE_ID },
    });
    expect(tx.storeWallet.update).toHaveBeenCalledWith({
      where: { storeId: STORE_ID },
      data: { balance: { increment: new Prisma.Decimal("200.00") } },
    });
    expect(tx.walletEntry.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        type: "CREDIT",
        source: "ORDER_PAYMENT",
        amount: new Prisma.Decimal("200.00"),
        balanceAfter: new Prisma.Decimal("200.00"),
        orderId: "order-9",
        payoutId: null,
      },
    });
  });
});
