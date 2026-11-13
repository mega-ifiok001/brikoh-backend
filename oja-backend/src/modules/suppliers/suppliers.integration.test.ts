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

beforeEach(async () => {
  await prisma.$executeRaw`
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" DISABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" DISABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_ledger_append_only;
    DELETE FROM "RefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
    DELETE FROM "CreditRepayment"; DELETE FROM "Order"; DELETE FROM "InvoicePayment";
    DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

describe("suppliers CRUD (integration)", () => {
  it("creates, lists, and reads a supplier with activity logging", async () => {
    const { store, token } = await createTenantWithOwner();

    const created = await request(app)
      .post("/api/dashboard/suppliers")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Prime Distributors",
        contactName: "Bola Adeyemi",
        phone: "+234 801 222 3333",
        email: "sales@primedistributors.example",
        address: "Lagos Island, Lagos",
      });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Prime Distributors",
      isActive: true,
      balanceDue: "0.00",
      purchaseOrderCount: 0,
    });

    const activity = await prisma.storeActivityLog.findFirst({
      where: { storeId: store.id, action: "supplier.created" },
    });
    expect(activity).not.toBeNull();

    const list = await request(app)
      .get("/api/dashboard/suppliers")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);

    const detail = await request(app)
      .get(`/api/dashboard/suppliers/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.purchaseOrders).toEqual([]);
  });

  it("rejects a duplicate name with 409", async () => {
    const { token } = await createTenantWithOwner();

    const body = { name: "Prime Distributors" };
    await request(app)
      .post("/api/dashboard/suppliers")
      .set("Authorization", `Bearer ${token}`)
      .send(body)
      .expect(201);
    const dup = await request(app)
      .post("/api/dashboard/suppliers")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("SUPPLIER_NAME_TAKEN");
  });

  it("updates a supplier and deactivates it", async () => {
    const { store, token } = await createTenantWithOwner();
    const created = await prisma.supplier.create({
      data: { storeId: store.id, name: "Prime Distributors" },
    });

    const updated = await request(app)
      .put(`/api/dashboard/suppliers/${created.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Prime Distributors Ltd", isActive: false });

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: "Prime Distributors Ltd", isActive: false });

    const activity = await prisma.storeActivityLog.findFirst({
      where: { storeId: store.id, action: "supplier.updated" },
    });
    expect(activity).not.toBeNull();
  });

  it("deletes a supplier with no orders and refuses one with orders", async () => {
    const { store, token } = await createTenantWithOwner();
    const empty = await prisma.supplier.create({ data: { storeId: store.id, name: "Empty" } });
    const used = await prisma.supplier.create({ data: { storeId: store.id, name: "Used" } });
    await prisma.purchaseOrder.create({
      data: {
        storeId: store.id,
        supplierId: used.id,
        branchId: (await prisma.branch.findFirstOrThrow({ where: { storeId: store.id } })).id,
        status: "ORDERED",
        number: "PO-0001",
        total: 100,
      },
    });

    const del = await request(app)
      .delete(`/api/dashboard/suppliers/${empty.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);

    const refused = await request(app)
      .delete(`/api/dashboard/suppliers/${used.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("SUPPLIER_HAS_ORDERS");
  });

  it("rejects staff without purchases.manage", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id, []);

    const res = await request(app)
      .post("/api/dashboard/suppliers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "X" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });

  it("validates input", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/suppliers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "X", phone: "not-a-phone" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
