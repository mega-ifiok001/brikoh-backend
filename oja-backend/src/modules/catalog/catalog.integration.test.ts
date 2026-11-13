import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";
import type { $Enums } from "../../../generated/prisma/client.js";

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
  permissions: string[],
  role: $Enums.StaffRole = "STAFF",
) {
  const email = `staff-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const staff = await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role, permissions },
  });
  const token = signAccessToken({ sub: account.id, storeId, role });
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
    DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "WalletEntry"; DELETE FROM "Payout"; DELETE FROM "StoreWallet"; DELETE FROM "BankAccount";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit";
    DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
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

describe("POST /api/dashboard/categories (integration)", () => {
  it("creates a category for the authenticated tenant", async () => {
    const { store, token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Beverages", description: "Hot and cold drinks" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Beverages", description: "Hot and cold drinks" });
    expect(res.body.storeId).toBe(store.id);

    const row = await prisma.category.findUnique({ where: { id: res.body.id } });
    expect(row?.storeId).toBe(store.id);
  });

  it("rejects a duplicate category name with 409 CATEGORY_EXISTS", async () => {
    const { token } = await createTenantWithOwner();
    await request(app)
      .post("/api/dashboard/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Beverages" });
    const res = await request(app)
      .post("/api/dashboard/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Beverages" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CATEGORY_EXISTS");
  });

  it("rejects invalid input with 400", async () => {
    const { token } = await createTenantWithOwner();
    const res = await request(app)
      .post("/api/dashboard/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires the catalog.manage permission (staff without it gets 403)", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id, ["products.manage"]);

    const res = await request(app)
      .post("/api/dashboard/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Beverages" });
    expect(res.status).toBe(403);

    const allowed = await createStaffMember(store.id, ["catalog.manage"]);
    const ok = await request(app)
      .post("/api/dashboard/categories")
      .set("Authorization", `Bearer ${allowed.token}`)
      .send({ name: "Snacks" });
    expect(ok.status).toBe(201);
  });
});

describe("GET /api/dashboard/categories (integration)", () => {
  it("lists only the tenant's categories", async () => {
    const { store, token } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    await prisma.category.createMany({
      data: [
        { storeId: store.id, name: "Mine A" },
        { storeId: other.store.id, name: "Theirs" },
        { storeId: store.id, name: "Mine B" },
      ],
    });

    const res = await request(app)
      .get("/api/dashboard/categories")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.map((c: { name: string }) => c.name)).toEqual(["Mine A", "Mine B"]);
  });
});

describe("GET/PATCH/DELETE /api/dashboard/categories/:categoryId (integration)", () => {
  it("returns 404 for unknown and cross-tenant ids", async () => {
    const { store, token } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    const theirs = await prisma.category.create({
      data: { storeId: other.store.id, name: "Theirs" },
    });

    for (const path of [
      `/api/dashboard/categories/00000000-0000-0000-0000-000000000000`,
      `/api/dashboard/categories/${theirs.id}`,
    ]) {
      const get = await request(app).get(path).set("Authorization", `Bearer ${token}`);
      expect(get.status).toBe(404);
      const patch = await request(app)
        .patch(path)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "X" });
      expect(patch.status).toBe(404);
      const del = await request(app).delete(path).set("Authorization", `Bearer ${token}`);
      expect(del.status).toBe(404);
    }
    void store;
  });

  it("updates a category and soft-detaches products on delete (SetNull)", async () => {
    const { store, token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Beverages" });

    const renamed = await request(app)
      .patch(`/api/dashboard/categories/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Drinks" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Drinks");

    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Coffee", price: 5, categoryId: created.body.id },
    });

    const del = await request(app)
      .delete(`/api/dashboard/categories/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);

    const kept = await prisma.product.findUnique({ where: { id: product.id } });
    expect(kept?.categoryId).toBeNull();
  });
});

describe("/api/dashboard/units (integration)", () => {
  it("creates, lists, updates, and deletes units tenant-scoped", async () => {
    const { store, token } = await createTenantWithOwner();

    const created = await request(app)
      .post("/api/dashboard/units")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Kilogram", symbol: "kg" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Kilogram", symbol: "kg" });
    expect(created.body.storeId).toBe(store.id);

    const dup = await request(app)
      .post("/api/dashboard/units")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Kilogram" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("UNIT_EXISTS");

    const listed = await request(app)
      .get("/api/dashboard/units")
      .set("Authorization", `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);

    const updated = await request(app)
      .patch(`/api/dashboard/units/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ symbol: "kgs" });
    expect(updated.status).toBe(200);
    expect(updated.body.symbol).toBe("kgs");

    const del = await request(app)
      .delete(`/api/dashboard/units/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);

    const gone = await request(app)
      .get(`/api/dashboard/units/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(gone.status).toBe(404);
  });
});

describe("products linked to catalog (integration)", () => {
  it("creates a product with category and unit, returned inline", async () => {
    const { store, token } = await createTenantWithOwner();
    const category = await prisma.category.create({ data: { storeId: store.id, name: "Bevs" } });
    const unit = await prisma.unit.create({ data: { storeId: store.id, name: "Bottle" } });

    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Coke", price: 2.5, categoryId: category.id, unitId: unit.id });

    expect(res.status).toBe(201);
    expect(res.body.category).toMatchObject({ id: category.id, name: "Bevs" });
    expect(res.body.unit).toMatchObject({ id: unit.id, name: "Bottle" });
  });

  it("rejects a cross-tenant category or unit on create and update with 404", async () => {
    const { token } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    const theirs = await prisma.category.create({
      data: { storeId: other.store.id, name: "Theirs" },
    });
    const theirUnit = await prisma.unit.create({
      data: { storeId: other.store.id, name: "TheirUnit" },
    });

    const create = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Coke", price: 2.5, categoryId: theirs.id });
    expect(create.status).toBe(404);
    expect(create.body.error.code).toBe("NOT_FOUND");

    const created = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Coke", price: 2.5 });
    const update = await request(app)
      .patch(`/api/dashboard/products/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ unitId: theirUnit.id });
    expect(update.status).toBe(404);
  });

  it("clears category and unit links when sent null on update", async () => {
    const { store, token } = await createTenantWithOwner();
    const category = await prisma.category.create({ data: { storeId: store.id, name: "Bevs" } });
    const unit = await prisma.unit.create({ data: { storeId: store.id, name: "Bottle" } });
    const created = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Coke", price: 2.5, categoryId: category.id, unitId: unit.id });
    expect(created.status).toBe(201);

    const cleared = await request(app)
      .patch(`/api/dashboard/products/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ categoryId: null, unitId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.category).toBeNull();
    expect(cleared.body.unit).toBeNull();
  });
});
