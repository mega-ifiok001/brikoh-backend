import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { expireAwaitingPaymentOrders } from "./service.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

const TENANT_WIPE = `
  ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
  ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
  ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_ledger_append_only;
  DELETE FROM "WalletEntry"; DELETE FROM "Payout"; DELETE FROM "StoreWallet"; DELETE FROM "BankAccount";
  DELETE FROM "NotificationDispatch"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem"; DELETE FROM "Order";
  DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
  DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
  DELETE FROM "BranchStock"; DELETE FROM "Branch"; DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
  DELETE FROM "StoreActivityLog"; DELETE FROM "PaymentCredential"; DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
  ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
  ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
  ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
`;

async function createAccount() {
  const email = `acct-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  return { account, email };
}

async function createTenantWithOwner() {
  const { account, email } = await createAccount();
  const store = await prisma.store.create({
    data: {
      name: `Store ${crypto.randomUUID().slice(0, 8)}`,
      subdomain: `s-${crypto.randomUUID().slice(0, 8)}`,
      businessType: "OTHER",
      location: "Lagos, Nigeria",
      businessPhone: "+234 801 234 5678",
    },
  });
  const mainBranch = await prisma.branch.create({
    data: { storeId: store.id, name: "Main Branch", address: "Lagos, Nigeria" },
  });
  await prisma.store.update({ where: { id: store.id }, data: { defaultBranchId: mainBranch.id } });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  return { account, email, store, mainBranch };
}

async function createProduct(storeId: string, quantity = 10) {
  const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { defaultBranchId: true },
  });
  const product = await prisma.product.create({
    data: {
      storeId,
      name: `Product ${crypto.randomUUID().slice(0, 8)}`,
      price: 9.99,
      quantity,
      status: "PUBLISHED",
    },
  });
  await prisma.branchStock.create({
    data: { storeId, branchId: defaultBranchId!, productId: product.id, variantId: null, quantity },
  });
  return product;
}

async function ownerToken(accountId: string) {
  const email = (await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).email;
  const res = await request(app)
    .post("/api/public/auth/login")
    .send({ email, password: "password-123" });
  return res.body.accessToken as string;
}

async function createBankAccount(
  storeId: string,
  overrides: Partial<{
    accountName: string;
    bankName: string;
    accountNumber: string;
    isDefault: boolean;
  }> = {},
) {
  return prisma.bankAccount.create({
    data: {
      storeId,
      accountName: overrides.accountName ?? "Adebayo Idowu",
      bankName: overrides.bankName ?? "Access Bank",
      accountNumber: overrides.accountNumber ?? "0123456789",
      isDefault: overrides.isDefault ?? true,
    },
  });
}

const CHECKOUT_BODY = (productId: string, paymentMethod = "bank_transfer") => ({
  customer: { name: "Ade Buyer", email: "buyer@example.com", phone: "08012345678" },
  items: [{ productId, quantity: 2 }],
  paymentMethod,
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(TENANT_WIPE);
});

describe("public checkout — bank transfer", () => {
  it("returns a BRK reference and a frozen bank-details snapshot (status PENDING)", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    await createBankAccount(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(CHECKOUT_BODY(product.id));

    expect(res.status).toBe(200);
    expect(res.body.payment.provider).toBe("bank_transfer");
    expect(res.body.payment.reference).toMatch(/^BRK-[A-Z0-9]{8,}$/);
    expect(res.body.payment.bankDetails).toEqual({
      bankName: "Access Bank",
      accountName: "Adebayo Idowu",
      accountNumber: "0123456789",
      reference: res.body.payment.reference,
    });
    expect(res.body.order.status).toBe("PENDING");

    const row = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id } });
    expect(row.bankName).toBe("Access Bank");
    expect(row.accountNumber).toBe("0123456789");
    expect(row.paymentSubmittedAt).toBeNull();
  });

  it("rejects bank-transfer checkout when no bank account is configured (no dead-end order)", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(CHECKOUT_BODY(product.id));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BANK_ACCOUNT_NOT_CONFIGURED");
    expect(await prisma.order.count()).toBe(0);
  });
});

describe("public order status + immutability", () => {
  it("reads bank details from the frozen snapshot even after the live account changes", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    const account = await createBankAccount(store.id);

    const checkout = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(CHECKOUT_BODY(product.id));
    const orderId = checkout.body.order.id as string;

    // Merchant edits their account after the customer checked out.
    await prisma.bankAccount.update({
      where: { id: account.id },
      data: { accountNumber: "0987654321", bankName: "Zenith Bank" },
    });

    const res = await request(app).get(`/api/public/orders/${orderId}`);
    expect(res.status).toBe(200);
    expect(res.body.bankDetails).toEqual({
      bankName: "Access Bank",
      accountName: "Adebayo Idowu",
      accountNumber: "0123456789",
      reference: checkout.body.payment.reference,
    });
  });

  it("records 'I have paid' (AWAITING_PAYMENT + paymentSubmittedAt) and notifies the merchant", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    await createBankAccount(store.id);

    const checkout = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(CHECKOUT_BODY(product.id));
    const orderId = checkout.body.order.id as string;

    const markPaid = await request(app).post(`/api/public/orders/${orderId}/mark-paid`);
    expect(markPaid.status).toBe(200);
    expect(markPaid.body.status).toBe("AWAITING_PAYMENT");

    const row = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(row.status).toBe("AWAITING_PAYMENT");
    expect(row.paymentSubmittedAt).not.toBeNull();

    const claimed = await prisma.notificationDispatch.findFirst({
      where: { kind: "PAYMENT_CLAIMED", refId: orderId },
    });
    expect(claimed).not.toBeNull();
  });

  it("is idempotent on repeated 'I have paid' clicks", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    await createBankAccount(store.id);

    const checkout = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(CHECKOUT_BODY(product.id));
    const orderId = checkout.body.order.id as string;
    await request(app).post(`/api/public/orders/${orderId}/mark-paid`);
    const second = await request(app).post(`/api/public/orders/${orderId}/mark-paid`);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("AWAITING_PAYMENT");
  });
});

describe("dashboard confirm / reject (owner)", () => {
  it("confirms: marks PAID, decrements stock, and does NOT credit the wallet", async () => {
    const { account, store } = await createTenantWithOwner();
    const product = await createProduct(store.id, 10);
    await createBankAccount(store.id);
    const token = await ownerToken(account.id);

    const checkout = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(CHECKOUT_BODY(product.id));
    const orderId = checkout.body.order.id as string;
    const total = checkout.body.order.total as string;

    await request(app).post(`/api/public/orders/${orderId}/mark-paid`);

    const confirm = await request(app)
      .post(`/api/dashboard/orders/${orderId}/confirm-payment`)
      .set("Authorization", `Bearer ${token}`)
      .send({ confirmedAmount: Number(total) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.order.status).toBe("PAID");

    const stock = await prisma.branchStock.findFirstOrThrow({
      where: { storeId: store.id, productId: product.id, variantId: null },
    });
    expect(stock.quantity).toBe(8);

    expect(await prisma.walletEntry.count({ where: { orderId } })).toBe(0);
  });

  it("rejects confirmation when the entered amount does not match the total", async () => {
    const { account, store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    await createBankAccount(store.id);
    const token = await ownerToken(account.id);

    const checkout = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(CHECKOUT_BODY(product.id));
    const orderId = checkout.body.order.id as string;
    await request(app).post(`/api/public/orders/${orderId}/mark-paid`);

    const confirm = await request(app)
      .post(`/api/dashboard/orders/${orderId}/confirm-payment`)
      .set("Authorization", `Bearer ${token}`)
      .send({ confirmedAmount: 1 });
    expect(confirm.status).toBe(422);
    expect(confirm.body.error.code).toBe("AMOUNT_MISMATCH");
  });

  it("blocks a second confirmation (double-confirm race)", async () => {
    const { account, store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    await createBankAccount(store.id);
    const token = await ownerToken(account.id);

    const checkout = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(CHECKOUT_BODY(product.id));
    const orderId = checkout.body.order.id as string;
    const total = checkout.body.order.total as string;
    await request(app).post(`/api/public/orders/${orderId}/mark-paid`);

    await request(app)
      .post(`/api/dashboard/orders/${orderId}/confirm-payment`)
      .set("Authorization", `Bearer ${token}`)
      .send({ confirmedAmount: Number(total) });
    const second = await request(app)
      .post(`/api/dashboard/orders/${orderId}/confirm-payment`)
      .set("Authorization", `Bearer ${token}`)
      .send({ confirmedAmount: Number(total) });
    expect(second.status).toBe(409);
  });

  it("rejects a claimed payment back to PENDING", async () => {
    const { account, store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    await createBankAccount(store.id);
    const token = await ownerToken(account.id);

    const checkout = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(CHECKOUT_BODY(product.id));
    const orderId = checkout.body.order.id as string;
    await request(app).post(`/api/public/orders/${orderId}/mark-paid`);

    const reject = await request(app)
      .post(`/api/dashboard/orders/${orderId}/reject-payment`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(reject.status).toBe(200);
    expect(reject.body.order.status).toBe("PENDING");
    const row = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(row.status).toBe("PENDING");
  });
});

describe("dashboard bank-account management (owner)", () => {
  it("creates a merchant bank account without contacting any provider", async () => {
    const { account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);

    const res = await request(app)
      .post("/api/dashboard/settings/bank-accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        accountName: "Adebayo Idowu",
        bankName: "Access Bank",
        accountNumber: "0123456789",
        isDefault: true,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      accountName: "Adebayo Idowu",
      bankName: "Access Bank",
      accountNumber: "0123456789",
      isDefault: true,
    });
    expect(res.body.id).toBeDefined();
  });

  it("rejects a non-10-digit account number", async () => {
    const { account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);

    const res = await request(app)
      .post("/api/dashboard/settings/bank-accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountName: "Adebayo Idowu", bankName: "Access Bank", accountNumber: "123" });
    expect(res.status).toBe(400);
  });
});

describe("bank-transfer expiry sweep", () => {
  it("reclaims a stale AWAITING_PAYMENT claim back to PENDING (stock untouched)", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id, 10);
    await createBankAccount(store.id);

    const checkout = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(CHECKOUT_BODY(product.id));
    const orderId = checkout.body.order.id as string;
    await request(app).post(`/api/public/orders/${orderId}/mark-paid`);
    // Age the claim well past the expiry window.
    await prisma.order.update({
      where: { id: orderId },
      data: { paymentSubmittedAt: new Date(Date.now() - 13 * 60 * 60 * 1000) },
    });

    const reclaimed = await expireAwaitingPaymentOrders();
    expect(reclaimed).toBe(1);

    const row = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(row.status).toBe("PENDING");
    expect(row.paymentSubmittedAt).toBeNull();
    const stock = await prisma.branchStock.findFirstOrThrow({
      where: { storeId: store.id, productId: product.id },
    });
    expect(stock.quantity).toBe(10);
  });

  it("expiry sweep and confirm on the same order never both apply (race)", async () => {
    const { account, store } = await createTenantWithOwner();
    const product = await createProduct(store.id, 10);
    await createBankAccount(store.id);
    const token = await ownerToken(account.id);

    const checkout = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(CHECKOUT_BODY(product.id));
    const orderId = checkout.body.order.id as string;
    const total = checkout.body.order.total as string;
    await request(app).post(`/api/public/orders/${orderId}/mark-paid`);
    await prisma.order.update({
      where: { id: orderId },
      data: { paymentSubmittedAt: new Date(Date.now() - 13 * 60 * 60 * 1000) },
    });

    // Fire the sweep and a confirm at the same order in the same tick.
    await Promise.all([
      expireAwaitingPaymentOrders(),
      request(app)
        .post(`/api/dashboard/orders/${orderId}/confirm-payment`)
        .set("Authorization", `Bearer ${token}`)
        .send({ confirmedAmount: Number(total) }),
    ]);

    const row = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    // Exactly one transition wins: PAID (confirm) or PENDING (sweep). Never
    // stuck in AWAITING_PAYMENT, never a partial double-apply.
    expect(["PAID", "PENDING"]).toContain(row.status);

    const stock = await prisma.branchStock.findFirstOrThrow({
      where: { storeId: store.id, productId: product.id },
    });
    if (row.status === "PAID") {
      expect(stock.quantity).toBe(8);
      expect(await prisma.walletEntry.count({ where: { orderId } })).toBe(0);
    } else {
      expect(stock.quantity).toBe(10);
    }
  });
});
