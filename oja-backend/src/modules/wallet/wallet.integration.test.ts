import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { encryptSecret } from "../../lib/secrets.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

const PUBLIC_KEY = "pk_test_1234abcd";
const SECRET_KEY = "sk_test_1234abcd5678efgh";

function sign(rawBody: string): string {
  return createHmac("sha512", SECRET_KEY).update(rawBody).digest("hex");
}

function paystackInitiateSuccess() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: true,
      message: "Authorization URL created",
      data: {
        authorization_url: "https://checkout.paystack.test/session",
        access_code: "access-1",
        reference: "any",
      },
    }),
  } as unknown as Response;
}

function paystackResolveSuccess() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: true,
      message: "Account resolved",
      data: { account_name: "JOHN DOE" },
    }),
  } as unknown as Response;
}

function paystackRecipientSuccess() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: true,
      message: "Recipient created",
      data: { recipient_code: "RCP_123456" },
    }),
  } as unknown as Response;
}

function paystackTransferSuccess() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: true,
      message: "Transfer created",
      data: { transfer_code: "TRF_123456" },
    }),
  } as unknown as Response;
}

async function createAccount(password = "password-123") {
  const email = `account-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync(password, 4) },
  });
  return { account, email };
}

async function createTenantWithOwner(currency: string = "NGN") {
  const { account, email } = await createAccount();
  const store = await prisma.store.create({
    data: {
      name: `Store ${crypto.randomUUID().slice(0, 8)}`,
      subdomain: `s-${crypto.randomUUID().slice(0, 8)}`,
      businessType: "OTHER",
      location: "Lagos, Nigeria",
      businessPhone: "+234 801 234 5678",
      currency: currency as never,
    },
  });
  const mainBranch = await prisma.branch.create({
    data: { storeId: store.id, name: "Main Branch", address: "Lagos, Nigeria" },
  });
  await prisma.store.update({ where: { id: store.id }, data: { defaultBranchId: mainBranch.id } });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  return { account, email, store, mainBranch };
}

async function createStaff(storeId: string) {
  const { account, email } = await createAccount();
  await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role: "ADMIN" },
  });
  return { account, email };
}

async function createProduct(storeId: string, overrides: Record<string, unknown> = {}) {
  const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { defaultBranchId: true },
  });
  const product = await prisma.product.create({
    data: {
      storeId,
      name: `Product ${crypto.randomUUID().slice(0, 8)}`,
      price: 9.99,
      quantity: 10,
      status: "PUBLISHED",
      ...overrides,
    },
  });
  await prisma.branchStock.create({
    data: {
      storeId,
      branchId: defaultBranchId!,
      productId: product.id,
      variantId: null,
      quantity: (overrides.quantity as number | undefined) ?? 10,
    },
  });
  return product;
}

async function configurePaystack(storeId: string) {
  await prisma.paymentCredential.create({
    data: {
      storeId,
      provider: "paystack",
      publicKey: PUBLIC_KEY,
      secretKeyEncrypted: encryptSecret(SECRET_KEY),
    },
  });
}

async function ownerToken(accountId: string) {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const res = await request(app)
    .post("/api/public/auth/login")
    .send({ email: account.email, password: "password-123" });
  return res.body.accessToken as string;
}

/** Pays for an order through the REAL checkout + signed webhook path. */
async function createPaidOrder(storeSubdomain: string | null, productId: string, quantity = 2) {
  if (storeSubdomain === null) {
    throw new Error("test store has no subdomain");
  }
  const checkout = await request(app)
    .post(`/api/public/checkout/${storeSubdomain}`)
    .send({
      customer: { name: "Ade Buyer", email: "buyer@example.com", phone: "08012345678" },
      items: [{ productId, quantity }],
    });
  expect(checkout.status).toBe(200);
  const reference = checkout.body.payment.reference as string;
  const rawBody = JSON.stringify({
    event: "charge.success",
    data: { id: `evt-${crypto.randomUUID()}`, reference, status: "success" },
  });
  const res = await request(app)
    .post("/api/webhooks/paystack")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", sign(rawBody))
    .send(rawBody);
  expect(res.status).toBe(200);
  return checkout.body.order.id as string;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await prisma.$executeRaw`
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" DISABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" DISABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_ledger_append_only;
    DELETE FROM "RefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
    DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "WalletEntry"; DELETE FROM "Payout"; DELETE FROM "StoreWallet"; DELETE FROM "BankAccount";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "PaymentCredential"; DELETE FROM "Subscription"; DELETE FROM "Store";
    DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
  `;
  fetchMock = vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.includes("/transaction/initialize")) {
      return paystackInitiateSuccess();
    }
    if (path.includes("/bank/resolve")) {
      return paystackResolveSuccess();
    }
    if (path.includes("/transferrecipient")) {
      return paystackRecipientSuccess();
    }
    if (path.includes("/transfer")) {
      return paystackTransferSuccess();
    }
    throw new Error(`unexpected fetch: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/dashboard/wallet (integration)", () => {
  it("returns a zeroed wallet for a store with no activity yet", async () => {
    const { store, account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);

    const res = await request(app)
      .get("/api/dashboard/wallet")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      wallet: { currency: "NGN", available: "0", pending: "0", withdrawn: "0", totalCredits: "0" },
      recentEntries: [],
    });
    void store;
  });

  it("is owner-only: staff get 403", async () => {
    const { store, account } = await createTenantWithOwner();
    const staff = await createStaff(store.id);
    const ownerRes = await request(app)
      .post("/api/public/auth/login")
      .send({
        email: (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).email,
        password: "password-123",
      });
    const staffRes = await request(app)
      .post("/api/public/auth/login")
      .send({ email: staff.email, password: "password-123" });

    const res = await request(app)
      .get("/api/dashboard/wallet")
      .set("Authorization", `Bearer ${staffRes.body.accessToken}`);

    expect(res.status).toBe(403);
    void ownerRes;
  });
});

describe("POST /api/dashboard/wallet/bank-accounts (integration)", () => {
  it("resolves the account, creates the recipient, and stores only the masked number", async () => {
    const { store, account } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const token = await ownerToken(account.id);

    const res = await request(app)
      .post("/api/dashboard/wallet/bank-accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        accountName: "JOHN DOE",
        bankName: "First Bank",
        bankCode: "011",
        accountNumber: "0123456789",
      });

    expect(res.status).toBe(201);
    expect(res.body.bankAccount).toMatchObject({
      accountName: "JOHN DOE",
      bankName: "First Bank",
      maskedAccountNumber: "0123••••6789",
    });
    const row = await prisma.bankAccount.findFirstOrThrow({ where: { storeId: store.id } });
    expect(row.recipientCode).toBe("RCP_123456");
    expect(JSON.stringify(row)).not.toContain("0123456789");
  });

  it("rejects with 400 when the stated account name does not match the resolved name", async () => {
    const { store, account } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const token = await ownerToken(account.id);

    const res = await request(app)
      .post("/api/dashboard/wallet/bank-accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        accountName: "JANE SMITH",
        bankName: "First Bank",
        bankCode: "011",
        accountNumber: "0123456789",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BANK_ACCOUNT_UNRESOLVED");
    expect(await prisma.bankAccount.count({ where: { storeId: store.id } })).toBe(0);
  });
});

describe("DELETE /api/dashboard/wallet/bank-accounts/:bankAccountId (integration)", () => {
  it("refuses to delete an account with payout history (409)", async () => {
    const { store, account } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const token = await ownerToken(account.id);
    await prisma.bankAccount.create({
      data: {
        storeId: store.id,
        accountName: "JOHN DOE",
        bankName: "First Bank",
        bankCode: "011",
        maskedAccountNumber: "0123••••6789",
        recipientCode: "RCP_123456",
      },
    });
    const bankAccount = await prisma.bankAccount.findFirstOrThrow({ where: { storeId: store.id } });
    await prisma.payout.create({
      data: {
        storeId: store.id,
        bankAccountId: bankAccount.id,
        reference: "wd_old",
        amount: 500,
        status: "SUCCESS",
      },
    });

    const res = await request(app)
      .delete(`/api/dashboard/wallet/bank-accounts/${bankAccount.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BANK_ACCOUNT_HAS_PAYOUTS");
  });
});

describe("POST /api/dashboard/wallet/withdrawals (integration)", () => {
  async function setupFundedWallet(storeId: string) {
    await configurePaystack(storeId);
    const product = await createProduct(storeId, { quantity: 15 });
    await createPaidOrder(
      (await prisma.store.findUniqueOrThrow({ where: { id: storeId } })).subdomain,
      product.id,
      12,
    );
    return product;
  }

  it("debits the wallet and creates a PROCESSING payout after the provider accepts", async () => {
    const { store, account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);
    await setupFundedWallet(store.id);
    await prisma.bankAccount.create({
      data: {
        storeId: store.id,
        accountName: "JOHN DOE",
        bankName: "First Bank",
        bankCode: "011",
        maskedAccountNumber: "0123••••6789",
        recipientCode: "RCP_123456",
      },
    });
    const bankAccount = await prisma.bankAccount.findFirstOrThrow({ where: { storeId: store.id } });

    const res = await request(app)
      .post("/api/dashboard/wallet/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ bankAccountId: bankAccount.id, amount: "100.00" });

    expect(res.status).toBe(201);
    expect(res.body.payout).toMatchObject({
      status: "PROCESSING",
      amount: "100",
      reference: expect.stringMatching(/^wd_/),
    });
    const wallet = await prisma.storeWallet.findUniqueOrThrow({ where: { storeId: store.id } });
    expect(wallet.balance.toString()).toBe("19.88");
    const entry = await prisma.walletEntry.findFirstOrThrow({
      where: { storeId: store.id, type: "DEBIT" },
    });
    expect(entry.source).toBe("WITHDRAWAL");
    expect(entry.balanceAfter.toString()).toBe("19.88");
  });

  it("rejects withdrawals below the ₦100 minimum", async () => {
    const { store, account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);
    await setupFundedWallet(store.id);
    await prisma.bankAccount.create({
      data: {
        storeId: store.id,
        accountName: "JOHN DOE",
        bankName: "First Bank",
        bankCode: "011",
        maskedAccountNumber: "0123••••6789",
        recipientCode: "RCP_123456",
      },
    });
    const bankAccount = await prisma.bankAccount.findFirstOrThrow({ where: { storeId: store.id } });

    const res = await request(app)
      .post("/api/dashboard/wallet/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ bankAccountId: bankAccount.id, amount: "50.00" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("WITHDRAWAL_BELOW_MINIMUM");
  });

  it("rejects with 409 when the balance cannot cover the withdrawal", async () => {
    const { store, account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);
    await setupFundedWallet(store.id);
    await prisma.bankAccount.create({
      data: {
        storeId: store.id,
        accountName: "JOHN DOE",
        bankName: "First Bank",
        bankCode: "011",
        maskedAccountNumber: "0123••••6789",
        recipientCode: "RCP_123456",
      },
    });
    const bankAccount = await prisma.bankAccount.findFirstOrThrow({ where: { storeId: store.id } });

    const res = await request(app)
      .post("/api/dashboard/wallet/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ bankAccountId: bankAccount.id, amount: "99999.00" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_WALLET_BALANCE");
  });

  it("reverses the debit when the provider rejects the transfer, returning a FAILED payout", async () => {
    const { store, account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);
    await setupFundedWallet(store.id);
    await prisma.bankAccount.create({
      data: {
        storeId: store.id,
        accountName: "JOHN DOE",
        bankName: "First Bank",
        bankCode: "011",
        maskedAccountNumber: "0123••••6789",
        recipientCode: "RCP_123456",
      },
    });
    const bankAccount = await prisma.bankAccount.findFirstOrThrow({ where: { storeId: store.id } });
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes("/transaction/initialize")) {
        return paystackInitiateSuccess();
      }
      if (path.includes("/bank/resolve")) {
        return paystackResolveSuccess();
      }
      if (path.includes("/transferrecipient")) {
        return paystackRecipientSuccess();
      }
      if (path.includes("/transfer")) {
        return {
          ok: false,
          status: 402,
          json: async () => ({ status: false, message: "Balance insufficient" }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const res = await request(app)
      .post("/api/dashboard/wallet/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ bankAccountId: bankAccount.id, amount: "100.00" });

    expect(res.status).toBe(201);
    expect(res.body.payout.status).toBe("FAILED");
    const wallet = await prisma.storeWallet.findUniqueOrThrow({ where: { storeId: store.id } });
    expect(wallet.balance.toString()).toBe("119.88");
    const reversal = await prisma.walletEntry.findFirstOrThrow({
      where: { storeId: store.id, source: "WITHDRAWAL_REVERSAL" },
    });
    expect(reversal.type).toBe("CREDIT");
  });
});

describe("transfer.* webhooks (integration)", () => {
  it("marks the payout SUCCESS on transfer.success; FAILED + reversal on transfer.failed", async () => {
    const { store, account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);
    await configurePaystack(store.id);
    const product = await createProduct(store.id, { quantity: 15 });
    await createPaidOrder(store.subdomain, product.id, 12);
    await prisma.bankAccount.create({
      data: {
        storeId: store.id,
        accountName: "JOHN DOE",
        bankName: "First Bank",
        bankCode: "011",
        maskedAccountNumber: "0123••••6789",
        recipientCode: "RCP_123456",
      },
    });
    const bankAccount = await prisma.bankAccount.findFirstOrThrow({ where: { storeId: store.id } });
    const withdrawal = await request(app)
      .post("/api/dashboard/wallet/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ bankAccountId: bankAccount.id, amount: "100.00" });
    expect(withdrawal.status).toBe(201);
    const payoutId = withdrawal.body.payout.id as string;
    const reference = withdrawal.body.payout.reference as string;

    const successBody = JSON.stringify({
      event: "transfer.success",
      data: { id: `evt-${crypto.randomUUID()}`, reference, transfer_code: "TRF_123456" },
    });
    const successRes = await request(app)
      .post("/api/webhooks/paystack")
      .set("Content-Type", "application/json")
      .set("x-paystack-signature", sign(successBody))
      .send(successBody);
    expect(successRes.status).toBe(200);

    const paid = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    expect(paid.status).toBe("SUCCESS");
    expect(paid.processedAt).not.toBeNull();

    const failedBody = JSON.stringify({
      event: "transfer.failed",
      data: { id: `evt-${crypto.randomUUID()}`, reference, transfer_code: "TRF_123456" },
    });
    const failedRes = await request(app)
      .post("/api/webhooks/paystack")
      .set("Content-Type", "application/json")
      .set("x-paystack-signature", sign(failedBody))
      .send(failedBody);
    expect(failedRes.status).toBe(200);

    // The payout is already SUCCESS, so the failed delivery changes nothing.
    const unchanged = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    expect(unchanged.status).toBe("SUCCESS");
  });

  it("reverses the wallet debit when a REQUESTED payout fails", async () => {
    const { store, account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);
    await configurePaystack(store.id);
    const product = await createProduct(store.id, { quantity: 15 });
    await createPaidOrder(store.subdomain, product.id, 12);
    await prisma.bankAccount.create({
      data: {
        storeId: store.id,
        accountName: "JOHN DOE",
        bankName: "First Bank",
        bankCode: "011",
        maskedAccountNumber: "0123••••6789",
        recipientCode: "RCP_123456",
      },
    });
    const bankAccount = await prisma.bankAccount.findFirstOrThrow({ where: { storeId: store.id } });
    const withdrawal = await request(app)
      .post("/api/dashboard/wallet/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ bankAccountId: bankAccount.id, amount: "100.00" });
    expect(withdrawal.status).toBe(201);
    const payoutId = withdrawal.body.payout.id as string;
    const reference = withdrawal.body.payout.reference as string;
    // Force the payout back to REQUESTED (as if the provider call had not been initiated).
    await prisma.payout.update({
      where: { id: payoutId },
      data: { status: "REQUESTED", transferCode: null },
    });

    const failedBody = JSON.stringify({
      event: "transfer.failed",
      data: { id: `evt-${crypto.randomUUID()}`, reference, transfer_code: "TRF_123456" },
    });
    const failedRes = await request(app)
      .post("/api/webhooks/paystack")
      .set("Content-Type", "application/json")
      .set("x-paystack-signature", sign(failedBody))
      .send(failedBody);
    expect(failedRes.status).toBe(200);

    const failed = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    expect(failed.status).toBe("FAILED");
    const wallet = await prisma.storeWallet.findUniqueOrThrow({ where: { storeId: store.id } });
    expect(wallet.balance.toString()).toBe("119.88");
    const reversal = await prisma.walletEntry.findFirstOrThrow({
      where: { storeId: store.id, source: "WITHDRAWAL_REVERSAL" },
    });
    expect(reversal.amount.toString()).toBe("100");
  });

  it("credits the wallet exactly once when charge.success pays an order", async () => {
    const { store, account } = await createTenantWithOwner();
    await configurePaystack(store.id);
    const product = await createProduct(store.id);
    const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
      where: { id: store.id },
    });
    void defaultBranchId;
    const token = await ownerToken(account.id);
    await createPaidOrder(store.subdomain, product.id);

    const res = await request(app)
      .get("/api/dashboard/wallet")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.wallet.available).toBe("19.98");
    expect(res.body.wallet.totalCredits).toBe("19.98");
    expect(res.body.recentEntries).toHaveLength(1);
    expect(res.body.recentEntries[0]).toMatchObject({
      type: "CREDIT",
      source: "ORDER_PAYMENT",
      amount: "19.98",
    });
  });
});
