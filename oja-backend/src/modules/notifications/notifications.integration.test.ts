import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";
import { defaultAlertSender, type AlertEmailSender } from "./email.js";
import { notifyPaymentReceived, sweepAlerts } from "./service.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

type Mock = ReturnType<typeof vi.fn>;

async function createTenantWithOwner(notificationSettings?: Record<string, boolean>) {
  const email = `owner-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const store = await prisma.store.create({
    data: {
      name: `Store ${crypto.randomUUID().slice(0, 8)}`,
      subdomain: `s-${crypto.randomUUID().slice(0, 8)}`,
      businessType: "OTHER",
      location: "Lagos, Nigeria",
      businessPhone: "+234 801 234 5678",
      notificationSettings: notificationSettings as never,
    },
  });
  const mainBranch = await prisma.branch.create({
    data: { storeId: store.id, name: "Main Branch", address: "Lagos, Nigeria" },
  });
  await prisma.store.update({ where: { id: store.id }, data: { defaultBranchId: mainBranch.id } });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  const token = signAccessToken({ sub: account.id, storeId: store.id, role: "OWNER" });
  return { account, store, mainBranch, token };
}

async function createStaffMember(storeId: string, permissions: string[]) {
  const email = `staff-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const staff = await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role: "STAFF", permissions },
  });
  const token = signAccessToken({
    sub: account.id,
    storeId,
    role: "STAFF",
    staffMemberId: staff.id,
  });
  return { account, staff, token };
}

async function createProductWithStock(
  storeId: string,
  branchId: string,
  quantity: number,
  threshold?: number,
) {
  const product = await prisma.product.create({
    data: {
      storeId,
      name: `P ${crypto.randomUUID().slice(0, 8)}`,
      price: 100,
      quantity,
      lowStockThreshold: threshold ?? null,
    },
  });
  const branchStock = await prisma.branchStock.create({
    data: { storeId, branchId, productId: product.id, quantity },
  });
  return { product, branchStock };
}

beforeEach(async () => {
  await prisma.$executeRaw`
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" DISABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" DISABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_ledger_append_only;
    DELETE FROM "RefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
    DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "WalletEntry"; DELETE FROM "Payout"; DELETE FROM "BankAccount"; DELETE FROM "StoreWallet";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "NotificationDispatch";
    DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

const NOW = new Date("2026-08-14T09:00:00.000Z");

describe("merchant-alert sweep (integration)", () => {
  it("emails the owner one LOW_STOCK alert and records a dispatch row; re-runs are silent", async () => {
    const { store, mainBranch, account } = await createTenantWithOwner();
    await createProductWithStock(store.id, mainBranch.id, 3, 5);
    const sender = { sendAlert: vi.fn() } as AlertEmailSender & { sendAlert: Mock };

    const first = await sweepAlerts(sender, NOW);

    expect(first).toEqual({ storesScanned: 1, emailsSent: 1 });
    expect(sender.sendAlert).toHaveBeenCalledTimes(1);
    expect(sender.sendAlert).toHaveBeenCalledWith(
      account.email,
      expect.objectContaining({ subject: expect.stringContaining("Low stock alert") }),
    );
    const dispatch = await prisma.notificationDispatch.findFirst({
      where: { storeId: store.id, kind: "LOW_STOCK" },
    });
    expect(dispatch).not.toBeNull();
    expect(dispatch?.sentQuantity).toBe(3);

    // Re-run with identical stock: dedup, nothing sent.
    sender.sendAlert.mockClear();
    const second = await sweepAlerts(sender, NOW);
    expect(second.emailsSent).toBe(0);
    expect(sender.sendAlert).not.toHaveBeenCalled();
  });

  it("re-alerts when stock worsens below the last alerted level", async () => {
    const { store, mainBranch, account } = await createTenantWithOwner();
    const { branchStock } = await createProductWithStock(store.id, mainBranch.id, 3, 5);
    const sender = { sendAlert: vi.fn() } as AlertEmailSender & { sendAlert: Mock };

    await sweepAlerts(sender, NOW);
    sender.sendAlert.mockClear();

    await prisma.branchStock.update({
      where: { id: branchStock.id },
      data: { quantity: 1 },
    });
    const again = await sweepAlerts(sender, NOW);

    expect(again.emailsSent).toBe(1);
    expect(sender.sendAlert).toHaveBeenCalledTimes(1);
    const dispatch = await prisma.notificationDispatch.findFirst({
      where: { storeId: store.id, kind: "LOW_STOCK" },
    });
    expect(dispatch?.sentQuantity).toBe(1);
    expect(account.email).toBeTruthy();
  });

  it("emails EXPIRING_SOON for products within the 7-day window", async () => {
    const { store, account } = await createTenantWithOwner();
    await prisma.product.create({
      data: {
        storeId: store.id,
        name: "Milk",
        price: 200,
        expiryDate: new Date("2026-08-18T00:00:00.000Z"),
      },
    });
    const sender = { sendAlert: vi.fn() } as AlertEmailSender & { sendAlert: Mock };

    const result = await sweepAlerts(sender, NOW);

    expect(result.emailsSent).toBe(1);
    expect(sender.sendAlert).toHaveBeenCalledWith(
      account.email,
      expect.objectContaining({ subject: expect.stringContaining("Expiring soon") }),
    );
    const dispatch = await prisma.notificationDispatch.findFirst({
      where: { storeId: store.id, kind: "EXPIRING_SOON" },
    });
    expect(dispatch).not.toBeNull();
  });

  it("never alerts a store with the toggles off", async () => {
    await createTenantWithOwner({
      lowStockAlerts: false,
      paymentAlerts: false,
      expiringSoonAlerts: false,
    });
    const sender = { sendAlert: vi.fn() } as AlertEmailSender & { sendAlert: Mock };

    const result = await sweepAlerts(sender, NOW);

    expect(result).toEqual({ storesScanned: 1, emailsSent: 0 });
    expect(sender.sendAlert).not.toHaveBeenCalled();
    expect(await prisma.notificationDispatch.count()).toBe(0);
  });
});

describe("payment alerts (integration)", () => {
  it("notifyPaymentReceived sends once per repayment row and dedups on replay", async () => {
    const { store } = await createTenantWithOwner();
    const customer = await prisma.customer.create({
      data: { storeId: store.id, name: "Ade Okafor" },
    });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Tomatoes", price: 500, quantity: 0 },
    });
    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        customerId: customer.id,
        branchId: (await prisma.branch.findFirst({ where: { storeId: store.id } }))!.id,
        orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
        source: "POS",
        paymentMethod: "CREDIT",
        total: 1000,
        amountPaid: 0,
        lineItems: {
          create: {
            storeId: store.id,
            productId: product.id,
            quantity: 2,
            unitPriceAtPurchase: 500,
          },
        },
      },
    });
    const repayment = await prisma.creditRepayment.create({
      data: { storeId: store.id, orderId: order.id, amount: 500 },
    });
    const sender = { sendAlert: vi.fn() } as AlertEmailSender & { sendAlert: Mock };

    await notifyPaymentReceived(sender, store.id, "CREDIT_REPAYMENT", repayment.id);
    expect(sender.sendAlert).toHaveBeenCalledTimes(1);
    expect(sender.sendAlert).toHaveBeenCalledWith(
      expect.stringContaining("owner-"),
      expect.objectContaining({
        subject: expect.stringContaining("Payment received"),
        text: expect.stringContaining("500.00"),
      }),
    );

    // The same financial row never alerts twice.
    sender.sendAlert.mockClear();
    await notifyPaymentReceived(sender, store.id, "CREDIT_REPAYMENT", repayment.id);
    expect(sender.sendAlert).not.toHaveBeenCalled();
  });
});

describe("dashboard notifications endpoints (integration)", () => {
  it("GET returns the recent dispatches for the owner", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    await createProductWithStock(store.id, mainBranch.id, 2, 4);
    await sweepAlerts(defaultAlertSender(), NOW);

    const res = await request(app)
      .get("/api/dashboard/notifications")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.dispatches.length).toBe(1);
    expect(res.body.dispatches[0]).toMatchObject({
      kind: "LOW_STOCK",
      refType: "BRANCH_STOCK",
      sentQuantity: 2,
    });
    expect(res.body.nextCursor).toBeNull();
  });

  it("rejects staff with 403 ACCESS_DENIED", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id, ["products.manage"]);

    const res = await request(app)
      .get("/api/dashboard/notifications")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });

  it("POST /test sends a test alert to the owner's mailbox", async () => {
    const { account, token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/notifications/test")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, to: account.email });
    // A test alert is not a business condition — no dispatch row.
    expect(await prisma.notificationDispatch.count()).toBe(0);
  });

  it("POST /test rejects staff with 403", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id, []);

    const res = await request(app)
      .post("/api/dashboard/notifications/test")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
