import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { encryptSecret } from "../../lib/secrets.js";
import { signAccessToken } from "../../lib/tokens.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);
const SECRET_KEY = "sk_test_1234abcd5678efgh";

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

function sign(rawBody: string): string {
  return createHmac("sha512", SECRET_KEY).update(rawBody).digest("hex");
}

async function createTenant() {
  const account = await prisma.account.create({
    data: {
      email: `owner-${crypto.randomUUID()}@example.com`,
      passwordHash: bcrypt.hashSync("password-123", 4),
    },
  });
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
  const token = signAccessToken({ sub: account.id, storeId: store.id, role: "OWNER" });
  return { store, mainBranch, token };
}

async function createProduct(storeId: string, branchId: string) {
  const product = await prisma.product.create({
    data: {
      storeId,
      name: `Product ${crypto.randomUUID().slice(0, 8)}`,
      price: 9.99,
      quantity: 10,
      status: "PUBLISHED",
    },
  });
  await prisma.branchStock.create({
    data: { storeId, branchId, productId: product.id, variantId: null, quantity: 10 },
  });
  return product;
}

async function createCustomer(storeId: string, email: string | null = "buyer@example.com") {
  return prisma.customer.create({
    data: { storeId, name: "Ade Buyer", email, phone: "08012345678", source: "MANUAL" },
  });
}

async function configurePaystack(storeId: string) {
  await prisma.paymentCredential.create({
    data: {
      storeId,
      provider: "paystack",
      publicKey: "pk_test_1234abcd",
      secretKeyEncrypted: encryptSecret(SECRET_KEY),
    },
  });
}

function receiptDispatches(storeId: string) {
  return prisma.notificationDispatch.findMany({ where: { storeId, kind: "RECEIPT" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await prisma.$executeRaw`
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_ledger_append_only;
    DELETE FROM "RefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
    DELETE FROM "NotificationDispatch"; DELETE FROM "Order"; DELETE FROM "Discount";
    DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "InvoicePayment"; DELETE FROM "Invoice";
    DELETE FROM "WalletEntry"; DELETE FROM "Payout"; DELETE FROM "StoreWallet"; DELETE FROM "BankAccount";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product";
    DELETE FROM "Customer"; DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog"; DELETE FROM "PaymentCredential"; DELETE FROM "Subscription"; DELETE FROM "Store";
    DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
  fetchMock = vi.fn(async () => paystackInitiateSuccess());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("customer receipts (integration)", () => {
  it("sends a receipt for a POS instant sale with a customer email", async () => {
    const { store, mainBranch, token } = await createTenant();
    const product = await createProduct(store.id, mainBranch.id);
    const customer = await createCustomer(store.id);

    const res = await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: "CASH",
        customerId: customer.id,
      });
    expect(res.status).toBe(201);

    await vi.waitFor(async () => {
      const dispatches = await receiptDispatches(store.id);
      expect(dispatches).toHaveLength(1);
    });
    const [dispatch] = await receiptDispatches(store.id);
    expect(dispatch).toMatchObject({ refType: "ORDER", refId: res.body.order.id });
  });

  it("captures receiptEmail on the order at POS sale time", async () => {
    const { store, mainBranch, token } = await createTenant();
    const product = await createProduct(store.id, mainBranch.id);
    const customer = await createCustomer(store.id, "buyer@example.com");

    const res = await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: "CASH",
        customerId: customer.id,
      });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id } });
    expect(order.receiptEmail).toBe("buyer@example.com");
  });

  it("skips the receipt for a walk-in POS cash sale with no email", async () => {
    const { store, mainBranch, token } = await createTenant();
    const product = await createProduct(store.id, mainBranch.id);

    const res = await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: "CASH",
      });
    expect(res.status).toBe(201);

    // Give the fire-and-forget a beat, then assert nothing was dispatched.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await receiptDispatches(store.id)).toHaveLength(0);
  });

  it("sends a receipt when the storefront card payment webhook settles the order", async () => {
    const { store, mainBranch } = await createTenant();
    await configurePaystack(store.id);
    const product = await createProduct(store.id, mainBranch.id);

    const checkout = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send({
        customer: { name: "Ade Buyer", email: "buyer@example.com", phone: "08012345678" },
        items: [{ productId: product.id, quantity: 2 }],
      });
    expect(checkout.status).toBe(200);
    const reference = checkout.body.payment.reference as string;

    const rawBody = JSON.stringify({
      event: "charge.success",
      data: { id: `evt-${crypto.randomUUID()}`, reference, status: "success" },
    });
    const webhook = await request(app)
      .post("/api/webhooks/paystack")
      .set("Content-Type", "application/json")
      .set("x-paystack-signature", sign(rawBody))
      .send(rawBody);
    expect(webhook.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { storeId: store.id } });
    const dispatches = await receiptDispatches(store.id);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ refType: "ORDER", refId: order.id });
  });

  it("sends a receipt when a bank-transfer order is confirmed", async () => {
    const { store, mainBranch, token } = await createTenant();
    const product = await createProduct(store.id, mainBranch.id);
    await prisma.bankAccount.create({
      data: {
        storeId: store.id,
        accountName: "Adebayo Idowu",
        bankName: "Access Bank",
        accountNumber: "0123456789",
        isDefault: true,
      },
    });

    const checkout = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send({
        customer: { name: "Ade Buyer", email: "buyer@example.com", phone: "08012345678" },
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: "bank_transfer",
      });
    expect(checkout.status).toBe(200);
    const orderId = checkout.body.order.id as string;

    await request(app).post(`/api/public/orders/${orderId}/mark-paid`).expect(200);
    const confirm = await request(app)
      .post(`/api/dashboard/orders/${orderId}/confirm-payment`)
      .set("Authorization", `Bearer ${token}`)
      .send({ confirmedAmount: checkout.body.order.total });
    expect(confirm.status).toBe(200);

    const dispatches = await receiptDispatches(store.id);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ refType: "ORDER", refId: orderId });
  });

  it("sends a receipt when an invoice payment is recorded", async () => {
    const { store, mainBranch, token } = await createTenant();
    const product = await createProduct(store.id, mainBranch.id);
    const customer = await createCustomer(store.id);

    const createInvoice = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "550.00" }],
      });
    expect(createInvoice.status).toBe(201);
    const invoiceId = createInvoice.body.invoice.id as string;

    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/issue`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "550.00" })
      .expect(200);

    const dispatches = await receiptDispatches(store.id);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ refType: "INVOICE_PAYMENT" });
  });

  it("suppresses receipts when the merchant turns them off", async () => {
    const { store, mainBranch, token } = await createTenant();
    const product = await createProduct(store.id, mainBranch.id);
    const customer = await createCustomer(store.id);
    await prisma.store.update({
      where: { id: store.id },
      data: { notificationSettings: { receiptsEnabled: false } },
    });

    await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: "CASH",
        customerId: customer.id,
      })
      .expect(201);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await receiptDispatches(store.id)).toHaveLength(0);
  });
});
