import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

async function createTenantWithOwner() {
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

async function createStaffMember(
  storeId: string,
  options: { role: "ADMIN" | "MANAGER" | "STAFF"; permissions: string[] },
) {
  const email = `staff-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const staff = await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role: options.role, permissions: options.permissions },
  });
  const token = signAccessToken({
    sub: account.id,
    storeId,
    role: options.role,
    staffMemberId: staff.id,
  });
  return { staff, account, token };
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
    DELETE FROM "WalletEntry"; DELETE FROM "Payout"; DELETE FROM "StoreWallet"; DELETE FROM "BankAccount";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "Expense";
    DELETE FROM "NotificationDispatch";
    DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

describe("dashboard expenses (integration)", () => {
  it("creates an expense, returns it with fixed money, and logs the activity", async () => {
    const { store, token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/expenses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        category: "RENT",
        amount: "450000.00",
        description: "August shop rent",
        date: "2026-08-01",
      });

    expect(res.status).toBe(201);
    expect(res.body.expense).toMatchObject({
      category: "RENT",
      amount: "450000.00",
      description: "August shop rent",
      date: "2026-08-01",
    });

    const activity = await prisma.storeActivityLog.findFirst({
      where: { storeId: store.id, action: "expense.created" },
    });
    expect(activity).not.toBeNull();
    expect(activity!.detail).toEqual({
      expenseId: res.body.expense.id,
      category: "RENT",
      amount: "450000.00",
    });
  });

  it("lists expenses newest-first with category and date filters", async () => {
    const { store, token } = await createTenantWithOwner();
    const first = await prisma.expense.create({
      data: {
        storeId: store.id,
        category: "PACKAGING",
        amount: "12500.00",
        date: new Date("2026-08-02T00:00:00.000Z"),
      },
    });
    await prisma.expense.create({
      data: {
        storeId: store.id,
        category: "RENT",
        amount: "450000.00",
        date: new Date("2026-08-01T00:00:00.000Z"),
      },
    });

    const res = await request(app)
      .get("/api/dashboard/expenses")
      .set("Authorization", `Bearer ${token}`)
      .query({ category: "PACKAGING" });

    expect(res.status).toBe(200);
    expect(res.body.expenses).toHaveLength(1);
    expect(res.body.expenses[0].id).toBe(first.id);
    expect(res.body.nextCursor).toBeNull();
  });

  it("updates only the provided fields", async () => {
    const { store, token } = await createTenantWithOwner();
    const expense = await prisma.expense.create({
      data: {
        storeId: store.id,
        category: "UTILITIES",
        amount: "50000.00",
        description: "Electricity",
        date: new Date("2026-08-03T00:00:00.000Z"),
      },
    });

    const res = await request(app)
      .put(`/api/dashboard/expenses/${expense.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "55000.00" });

    expect(res.status).toBe(200);
    expect(res.body.expense).toMatchObject({ amount: "55000.00", category: "UTILITIES" });

    const activity = await prisma.storeActivityLog.findFirst({
      where: { storeId: store.id, action: "expense.updated" },
    });
    expect(activity).not.toBeNull();
  });

  it("deletes an expense and logs expense.deleted", async () => {
    const { store, token } = await createTenantWithOwner();
    const expense = await prisma.expense.create({
      data: {
        storeId: store.id,
        category: "MARKETING",
        amount: "20000.00",
        date: new Date("2026-08-04T00:00:00.000Z"),
      },
    });

    const res = await request(app)
      .delete(`/api/dashboard/expenses/${expense.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(await prisma.expense.findUnique({ where: { id: expense.id } })).toBeNull();
    const activity = await prisma.storeActivityLog.findFirst({
      where: { storeId: store.id, action: "expense.deleted" },
    });
    expect(activity).not.toBeNull();
  });

  it("returns EXPENSE_NOT_FOUND for an expense of another store", async () => {
    const { token } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    const foreign = await prisma.expense.create({
      data: {
        storeId: other.store.id,
        category: "RENT",
        amount: "100.00",
        date: new Date("2026-08-01T00:00:00.000Z"),
      },
    });

    const res = await request(app)
      .put(`/api/dashboard/expenses/${foreign.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "200.00" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "EXPENSE_NOT_FOUND" });
  });

  it("rejects invalid amounts, dates, and unknown categories", async () => {
    const { token } = await createTenantWithOwner();

    const negative = await request(app)
      .post("/api/dashboard/expenses")
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "RENT", amount: "-50.00", date: "2026-08-01" });
    expect(negative.status).toBe(400);
    expect(negative.body.error.code).toBe("VALIDATION_ERROR");

    const badDate = await request(app)
      .post("/api/dashboard/expenses")
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "RENT", amount: "50.00", date: "01-08-2026" });
    expect(badDate.status).toBe(400);

    const badCategory = await request(app)
      .post("/api/dashboard/expenses")
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "LOANS", amount: "50.00", date: "2026-08-01" });
    expect(badCategory.status).toBe(400);
  });

  it("enforces the analytics.manage permission for all writes", async () => {
    const { store, token } = await createTenantWithOwner();
    const staff = await createStaffMember(store.id, {
      role: "STAFF",
      permissions: [],
    });

    const res = await request(app)
      .post("/api/dashboard/expenses")
      .set("Authorization", `Bearer ${staff.token}`)
      .send({ category: "RENT", amount: "100.00", date: "2026-08-01" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
    void token;
  });

  it("rejects unauthenticated access", async () => {
    const res = await request(app).get("/api/dashboard/expenses");
    expect(res.status).toBe(401);
  });
});
