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

async function createProductRow(storeId: string, overrides: Record<string, unknown> = {}) {
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

describe("POST /api/dashboard/products (integration)", () => {
  it("creates a product for the authenticated tenant", async () => {
    const { store, token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ceramic Mug", price: 8, description: "Handmade" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Ceramic Mug", price: "8", quantity: 0, images: [] });
    expect(res.body.storeId).toBe(store.id);

    const row = await prisma.product.findUnique({ where: { id: res.body.id } });
    expect(row?.storeId).toBe(store.id);
  });

  it("stores an optional costPrice and keeps it distinct from price", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Sneakers", price: 45, costPrice: "33.50" });

    expect(res.status).toBe(201);
    expect(res.body.costPrice).toBe("33.5");
    expect(res.body.price).toBe("45");

    const row = await prisma.product.findUnique({ where: { id: res.body.id } });
    expect(row?.costPrice?.toString()).toBe("33.5");
  });

  it("stores costPrice null when omitted (existing flows unaffected)", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "No Cost", price: 10 });

    expect(res.status).toBe(201);
    expect(res.body.costPrice).toBeNull();
    const row = await prisma.product.findUnique({ where: { id: res.body.id } });
    expect(row?.costPrice).toBeNull();
  });

  it("creates a product with variants: nested rows with denormalized storeId, product quantity stays 0", async () => {
    const { store, token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "T-Shirt",
        price: 15,
        variants: [
          { name: "M", sellingPrice: 18 },
          { name: "L", sku: "TS-L" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.variants).toHaveLength(2);
    expect(res.body.variants[0]).toMatchObject({ name: "M", sellingPrice: "18", quantity: 0 });
    expect(res.body.variants[1]).toMatchObject({
      name: "L",
      sellingPrice: null,
      sku: "TS-L",
      quantity: 0,
    });
    expect(res.body.quantity).toBe(0);

    const rows = await prisma.productVariant.findMany({
      where: { productId: res.body.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.storeId === store.id)).toBe(true);
  });

  it("creates a single-variant product without variants (existing flows unaffected)", async () => {
    const { store, token } = await createTenantWithOwner();
    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Plain Cup", price: 5 });

    expect(res.status).toBe(201);
    expect(res.body.variants).toEqual([]);
    const row = await prisma.product.findUnique({ where: { id: res.body.id } });
    expect(row?.storeId).toBe(store.id);
  });

  it("rejects invalid variants with 400", async () => {
    const { token } = await createTenantWithOwner();
    const invalidBodies = [
      { name: "", price: 5, variants: [{ name: "" }] },
      { name: "X", price: 5, variants: [{ name: "M", sellingPrice: 100_000_000 }] },
      { name: "X", price: 5, variants: new Array(51).fill({ name: "M" }) },
      { name: "X", price: 5, variants: [{ name: "M", sku: "s".repeat(65) }] },
    ];
    for (const body of invalidBodies) {
      const res = await request(app)
        .post("/api/dashboard/products")
        .set("Authorization", `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects invalid input with 400 VALIDATION_ERROR", async () => {
    const { token } = await createTenantWithOwner();
    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "", price: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app).post("/api/dashboard/products").send({ name: "Mug", price: 8 });
    expect(res.status).toBe(401);
  });

  it("rejects a staff member without products.manage", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id, []);
    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Mug", price: 8 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });
});

describe("GET /api/dashboard/products (integration)", () => {
  it("serves products with their variants on list and detail", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: "Shirt",
        price: 15,
        variants: {
          create: [
            { name: "M", storeId: store.id },
            { name: "L", storeId: store.id },
          ],
        },
      },
    });

    const list = await request(app)
      .get("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.items[0]!.variants).toHaveLength(2);

    const detail = await request(app)
      .get(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.variants.map((v: { name: string }) => v.name).sort()).toEqual(["L", "M"]);
  });

  it("paginates by cursor without duplicates and reports the total", async () => {
    const { store, token } = await createTenantWithOwner();
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createProductRow(store.id, { name: `P${i}` })),
    );

    const page1 = await request(app)
      .get("/api/dashboard/products?limit=2")
      .set("Authorization", `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.total).toBe(5);
    expect(page1.body.nextCursor).toBeTypeOf("string");

    const page2 = await request(app)
      .get(`/api/dashboard/products?limit=2&cursor=${page1.body.nextCursor}`)
      .set("Authorization", `Bearer ${token}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(2);

    const page3 = await request(app)
      .get(
        page2.body.nextCursor === null
          ? "/api/dashboard/products?limit=10"
          : `/api/dashboard/products?limit=10&cursor=${page2.body.nextCursor}`,
      )
      .set("Authorization", `Bearer ${token}`);
    expect(page3.status).toBe(200);
    expect(page3.body.nextCursor).toBeNull();

    const seen = [...page1.body.items, ...page2.body.items, ...page3.body.items];
    expect(new Set(seen.map((p: { id: string }) => p.id)).size).toBe(seen.length);
    expect(seen.map((p: { id: string }) => p.id).sort()).toEqual(created.map((p) => p.id).sort());
  });

  it("excludes soft-deleted products and rejects a stale cursor", async () => {
    const { store, token } = await createTenantWithOwner();
    const deleted = await createProductRow(store.id);
    await prisma.product.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });

    const res = await request(app)
      .get("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.items.some((p: { id: string }) => p.id === deleted.id)).toBe(false);

    // A cursor row that no longer exists at all (hard-removed) is a
    // validation error, not a silent empty page.
    const ghost = await createProductRow(store.id);
    await prisma.product.delete({ where: { id: ghost.id } });

    const stale = await request(app)
      .get(`/api/dashboard/products?cursor=${ghost.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(stale.status).toBe(400);
  });

  it("rejects an invalid limit", async () => {
    const { token } = await createTenantWithOwner();
    const res = await request(app)
      .get("/api/dashboard/products?limit=0")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/dashboard/products/:productId (integration)", () => {
  it("returns the product", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, { name: "Coffee", price: 12.5 });

    const res = await request(app)
      .get(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Coffee");
    expect(res.body.price).toBe("12.5");
  });

  it("returns 404 for a soft-deleted product", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);
    await prisma.product.update({
      where: { id: product.id },
      data: { deletedAt: new Date() },
    });

    const res = await request(app)
      .get(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/dashboard/products/:productId (integration)", () => {
  it("updates fields and never the quantity", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);

    const res = await request(app)
      .patch(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Renamed", price: 19.99, description: null });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Renamed", price: "19.99", description: null });

    const attempted = await request(app)
      .patch(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ quantity: 99 });
    expect(attempted.status).toBe(400);
    expect(attempted.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("updates costPrice and clears it with null", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);

    const set = await request(app)
      .patch(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ costPrice: "12.25" });
    expect(set.status).toBe(200);
    expect(set.body.costPrice).toBe("12.25");
    const cleared = await request(app)
      .patch(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ costPrice: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.costPrice).toBeNull();
  });

  it("rejects adding or changing variants through the update endpoint (create-only)", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);

    const res = await request(app)
      .patch(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ variants: [{ name: "M" }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.productVariant.count({ where: { productId: product.id } })).toBe(0);
  });

  it("returns 404 when the product belongs to another tenant", async () => {
    const { token } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    const foreign = await createProductRow(other.store.id);

    const res = await request(app)
      .patch(`/api/dashboard/products/${foreign.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Hijacked" });

    expect(res.status).toBe(404);
    const row = await prisma.product.findUnique({ where: { id: foreign.id } });
    expect(row?.name).not.toBe("Hijacked");
  });
});

describe("DELETE /api/dashboard/products/:productId (integration)", () => {
  it("soft-deletes and hides the product from every other endpoint", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);

    const res = await request(app)
      .delete(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);

    const row = await prisma.product.findUnique({ where: { id: product.id } });
    expect(row?.deletedAt).not.toBeNull();

    const again = await request(app)
      .delete(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(again.status).toBe(204);

    const get = await request(app)
      .get(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(404);

    const update = await request(app)
      .patch(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Nope" });
    expect(update.status).toBe(404);
  });

  it("soft-deletes a product that still has order history (edge)", async () => {
    const { store, token } = await createTenantWithOwner();
    const customer = await prisma.customer.create({
      data: { storeId: store.id, name: "Walk-in" },
    });
    const product = await createProductRow(store.id);
    const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
      where: { id: store.id },
      select: { defaultBranchId: true },
    });
    await prisma.order.create({
      data: {
        storeId: store.id,
        customerId: customer.id,
        branchId: defaultBranchId!,
        orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
        total: 9.99,
        lineItems: {
          create: [
            { storeId: store.id, productId: product.id, quantity: 1, unitPriceAtPurchase: 9.99 },
          ],
        },
      },
    });

    const res = await request(app)
      .delete(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(204);
    const row = await prisma.product.findUnique({ where: { id: product.id } });
    expect(row?.deletedAt).not.toBeNull();
    expect(await prisma.orderLineItem.count({ where: { productId: product.id } })).toBe(1);
  });

  it("returns 404 for a foreign product (cross-tenant)", async () => {
    const { token } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    const foreign = await createProductRow(other.store.id);

    const res = await request(app)
      .delete(`/api/dashboard/products/${foreign.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/dashboard/products/:productId/stock-adjustments (integration)", () => {
  it("restocks and decrements while appending ledger entries", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, { quantity: 0 });

    const restock = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: mainBranch.id, quantityChange: 10, reason: "RESTOCK" });
    expect(restock.status).toBe(200);
    expect(restock.body.product.quantity).toBe(10);
    expect(restock.body.ledgerEntry.quantityChange).toBe(10);
    expect(restock.body.ledgerEntry.reason).toBe("RESTOCK");

    const sell = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: mainBranch.id, quantityChange: -4, reason: "MANUAL_ADJUSTMENT" });
    expect(sell.status).toBe(200);
    expect(sell.body.product.quantity).toBe(6);

    expect(await prisma.stockLedgerEntry.count({ where: { productId: product.id } })).toBe(2);
  });

  it("rejects over-selling with 409 and persists nothing", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, { quantity: 3 });

    const res = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: mainBranch.id, quantityChange: -5, reason: "MANUAL_ADJUSTMENT" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    const row = await prisma.product.findUnique({ where: { id: product.id } });
    expect(row?.quantity).toBe(3);
    expect(await prisma.stockLedgerEntry.count({ where: { productId: product.id } })).toBe(0);
  });

  it("rejects SALE as a manual reason", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);

    const res = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: mainBranch.id, quantityChange: -1, reason: "SALE" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_STOCK_REASON");
  });

  it("rejects a zero quantity change", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);

    const res = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: mainBranch.id, quantityChange: 0, reason: "MANUAL_ADJUSTMENT" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 for a foreign product (cross-tenant)", async () => {
    const { mainBranch, token } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    const foreign = await createProductRow(other.store.id);

    const res = await request(app)
      .post(`/api/dashboard/products/${foreign.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: mainBranch.id, quantityChange: -1, reason: "MANUAL_ADJUSTMENT" });

    expect(res.status).toBe(404);
    expect(await prisma.stockLedgerEntry.count({ where: { productId: foreign.id } })).toBe(0);
  });

  it("rejects adjustments to soft-deleted products", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);
    await prisma.product.update({
      where: { id: product.id },
      data: { deletedAt: new Date() },
    });

    const res = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: mainBranch.id, quantityChange: 5, reason: "RESTOCK" });

    expect(res.status).toBe(404);
  });

  it("writes performedByStaffId for staff and null for owners", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const { staff } = await createStaffMember(store.id, ["products.manage"]);
    const staffToken = signAccessToken({
      sub: staff.accountId,
      storeId: store.id,
      role: "STAFF",
      staffMemberId: staff.id,
    });
    const product = await createProductRow(store.id);

    const byStaff = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ branchId: mainBranch.id, quantityChange: 1, reason: "MANUAL_ADJUSTMENT" });
    expect(byStaff.status).toBe(200);
    expect(byStaff.body.ledgerEntry.performedByStaffId).toBe(staff.id);

    const byOwner = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: mainBranch.id, quantityChange: 1, reason: "MANUAL_ADJUSTMENT" });
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.ledgerEntry.performedByStaffId).toBeNull();
  });

  it("prevents concurrent over-selling: exactly one of two decrements wins", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, { quantity: 5 });

    const [a, b] = await Promise.allSettled([
      request(app)
        .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
        .set("Authorization", `Bearer ${token}`)
        .send({ branchId: mainBranch.id, quantityChange: -5, reason: "MANUAL_ADJUSTMENT" }),
      request(app)
        .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
        .set("Authorization", `Bearer ${token}`)
        .send({ branchId: mainBranch.id, quantityChange: -5, reason: "MANUAL_ADJUSTMENT" }),
    ]);

    const statuses = [a, b].map((r) => (r.status === "fulfilled" ? r.value.status : "rejected"));
    expect(statuses.sort()).toEqual([200, 409]);

    const row = await prisma.product.findUnique({ where: { id: product.id } });
    expect(row?.quantity).toBe(0);
    expect(await prisma.stockLedgerEntry.count({ where: { productId: product.id } })).toBe(1);
  });

  it("allows two concurrent restocks to both succeed", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, { quantity: 0 });

    const results = await Promise.allSettled([
      request(app)
        .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
        .set("Authorization", `Bearer ${token}`)
        .send({ branchId: mainBranch.id, quantityChange: 5, reason: "RESTOCK" }),
      request(app)
        .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
        .set("Authorization", `Bearer ${token}`)
        .send({ branchId: mainBranch.id, quantityChange: 5, reason: "RESTOCK" }),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const row = await prisma.product.findUnique({ where: { id: product.id } });
    expect(row?.quantity).toBe(10);
    expect(await prisma.stockLedgerEntry.count({ where: { productId: product.id } })).toBe(2);
  });

  it("adjusts a variant's stock: variant moves, product quantity untouched, ledger row names the variant", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, { quantity: 0 });
    const variantM = await prisma.productVariant.create({
      data: { storeId: store.id, productId: product.id, name: "M" },
    });
    const variantL = await prisma.productVariant.create({
      data: { storeId: store.id, productId: product.id, name: "L" },
    });

    const restock = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        branchId: mainBranch.id,
        variantId: variantM.id,
        quantityChange: 10,
        reason: "RESTOCK",
      });
    expect(restock.status).toBe(200);
    expect(restock.body.variant).toMatchObject({ id: variantM.id, name: "M", quantity: 10 });
    expect(restock.body.product.quantity).toBe(0);
    expect(restock.body.ledgerEntry.variantId).toBe(variantM.id);

    const sell = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        branchId: mainBranch.id,
        variantId: variantM.id,
        quantityChange: -4,
        reason: "MANUAL_ADJUSTMENT",
      });
    expect(sell.status).toBe(200);
    expect(sell.body.variant.quantity).toBe(6);

    const sibling = await prisma.productVariant.findUnique({ where: { id: variantL.id } });
    expect(sibling?.quantity).toBe(0);
    const productRowAfter = await prisma.product.findUnique({ where: { id: product.id } });
    expect(productRowAfter?.quantity).toBe(0);
    expect(await prisma.stockLedgerEntry.count({ where: { variantId: variantM.id } })).toBe(2);
    expect(await prisma.stockLedgerEntry.count({ where: { variantId: variantL.id } })).toBe(0);
  });

  it("rejects over-selling a variant with 409 and persists nothing", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);
    const variant = await prisma.productVariant.create({
      data: { storeId: store.id, productId: product.id, name: "M", quantity: 3 },
    });

    const res = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        branchId: mainBranch.id,
        variantId: variant.id,
        quantityChange: -5,
        reason: "MANUAL_ADJUSTMENT",
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    const row = await prisma.productVariant.findUnique({ where: { id: variant.id } });
    expect(row?.quantity).toBe(3);
    expect(await prisma.stockLedgerEntry.count({ where: { productId: product.id } })).toBe(0);
  });

  it("rejects product-level adjustments when the product has variants (400 VARIANT_REQUIRED)", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, { quantity: 5 });
    await prisma.productVariant.create({
      data: { storeId: store.id, productId: product.id, name: "M" },
    });

    const res = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: mainBranch.id, quantityChange: 1, reason: "RESTOCK" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VARIANT_REQUIRED");
    const row = await prisma.product.findUnique({ where: { id: product.id } });
    expect(row?.quantity).toBe(5);
  });

  it("returns 404 VARIANT_NOT_FOUND for a variant that belongs to another product", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);
    const other = await createProductRow(store.id);
    const foreignVariant = await prisma.productVariant.create({
      data: { storeId: store.id, productId: other.id, name: "M" },
    });

    const res = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        branchId: mainBranch.id,
        variantId: foreignVariant.id,
        quantityChange: 1,
        reason: "RESTOCK",
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("VARIANT_NOT_FOUND");
    expect(await prisma.stockLedgerEntry.count({ where: { productId: product.id } })).toBe(0);
  });

  it("rejects a non-string variantId as a validation error", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);

    const res = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: mainBranch.id, variantId: "", quantityChange: 1, reason: "RESTOCK" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("product publish lifecycle (integration)", () => {
  async function seedCatalogRows(storeId: string) {
    const category = await prisma.category.create({
      data: { storeId, name: `Cat ${crypto.randomUUID().slice(0, 8)}` },
    });
    const unit = await prisma.unit.create({
      data: { storeId, name: `Unit ${crypto.randomUUID().slice(0, 8)}` },
    });
    return { category, unit };
  }

  it("creates products as DRAFT by default and publishes them explicitly", async () => {
    const { store, token } = await createTenantWithOwner();
    const { category, unit } = await seedCatalogRows(store.id);
    const created = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Draft Mug", price: 5 });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("DRAFT");

    // The publish gate: a bare product (no category/unit/photo) must be
    // rejected even though name and price are present.
    const blocked = await request(app)
      .post(`/api/dashboard/products/${created.body.id}/publish`)
      .set("Authorization", `Bearer ${token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("PRODUCT_NOT_READY_TO_PUBLISH");
    expect(blocked.body.error.message).toMatch(/category/);

    const ready = await request(app)
      .patch(`/api/dashboard/products/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        categoryId: category.id,
        unitId: unit.id,
        coverImageUrl: "https://cdn.example.com/mug.jpg",
      });
    expect(ready.status).toBe(200);

    const published = await request(app)
      .post(`/api/dashboard/products/${created.body.id}/publish`)
      .set("Authorization", `Bearer ${token}`);
    expect(published.status).toBe(200);
    expect(published.body.status).toBe("PUBLISHED");

    const unpublished = await request(app)
      .post(`/api/dashboard/products/${created.body.id}/unpublish`)
      .set("Authorization", `Bearer ${token}`);
    expect(unpublished.status).toBe(200);
    expect(unpublished.body.status).toBe("DRAFT");

    const row = await prisma.product.findUnique({ where: { id: created.body.id } });
    expect(row?.status).toBe("DRAFT");
  });

  it("publish/unpublish are idempotent and 404 for unknown products", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, { status: "PUBLISHED" });

    const again = await request(app)
      .post(`/api/dashboard/products/${product.id}/publish`)
      .set("Authorization", `Bearer ${token}`);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("PUBLISHED");

    const missing = await request(app)
      .post("/api/dashboard/products/00000000-0000-0000-0000-000000000000/publish")
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(404);
  });

  it("rejects publishing when only the unit or photo is missing", async () => {
    const { store, token } = await createTenantWithOwner();
    const { category } = await seedCatalogRows(store.id);

    const created = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Half-Configured Mug",
        price: 5,
        categoryId: category.id,
        coverImageUrl: "https://cdn.example.com/mug.jpg",
      });
    expect(created.status).toBe(201);

    const blocked = await request(app)
      .post(`/api/dashboard/products/${created.body.id}/publish`)
      .set("Authorization", `Bearer ${token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("PRODUCT_NOT_READY_TO_PUBLISH");
    expect(blocked.body.error.message).toMatch(/unit/);
    expect(blocked.body.error.message).not.toMatch(/photo/);
  });

  it("records publish/unpublish in the store activity log", async () => {
    const { store, token } = await createTenantWithOwner();
    const { category, unit } = await seedCatalogRows(store.id);
    const product = await createProductRow(store.id, {
      status: "DRAFT",
      categoryId: category.id,
      unitId: unit.id,
      coverImageUrl: "https://cdn.example.com/mug.jpg",
    });
    await request(app)
      .post(`/api/dashboard/products/${product.id}/publish`)
      .set("Authorization", `Bearer ${token}`);
    await request(app)
      .post(`/api/dashboard/products/${product.id}/unpublish`)
      .set("Authorization", `Bearer ${token}`);

    const actions = await prisma.storeActivityLog.findMany({
      where: { storeId: store.id },
      select: { action: true },
      orderBy: { createdAt: "asc" },
    });
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(["product.published", "product.unpublished"]),
    );
  });
});

describe("product publish fields (integration)", () => {
  it("round-trips coverImageUrl, lowStockThreshold, expiryDate, and discountPrice", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Perishables",
        price: 20,
        coverImageUrl: "https://cdn.example.com/cover.jpg",
        lowStockThreshold: 5,
        expiryDate: "2026-12-31T23:59:59Z",
        discountPrice: 15,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      coverImageUrl: "https://cdn.example.com/cover.jpg",
      lowStockThreshold: 5,
      discountPrice: "15",
    });
    expect(new Date(res.body.expiryDate).toISOString()).toBe("2026-12-31T23:59:59.000Z");

    const row = await prisma.product.findUnique({ where: { id: res.body.id } });
    expect(row?.coverImageUrl).toBe("https://cdn.example.com/cover.jpg");
    expect(row?.lowStockThreshold).toBe(5);
    expect(row?.discountPrice?.toString()).toBe("15");
  });

  it("rejects discountPrice >= price on create", async () => {
    const { token } = await createTenantWithOwner();
    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Mug", price: 10, discountPrice: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a discountPrice raised above the current price on update", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, { price: 10 });

    const res = await request(app)
      .patch(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ discountPrice: 12 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");

    const ok = await request(app)
      .patch(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ discountPrice: 8 });
    expect(ok.status).toBe(200);
    expect(ok.body.discountPrice).toBe("8");

    const cleared = await request(app)
      .patch(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ discountPrice: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.discountPrice).toBeNull();
  });
});

describe("starting stock (initialStock) on create (integration)", () => {
  it("seeds a variant-less product with an INITIAL_STOCK ledger entry", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Seeded Coffee", price: 12, initialStock: 25 });

    expect(res.status).toBe(201);
    expect(res.body.quantity).toBe(25);

    const entries = await prisma.stockLedgerEntry.findMany({
      where: { productId: res.body.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      productId: res.body.id,
      variantId: null,
      quantityChange: 25,
      reason: "INITIAL_STOCK",
    });
  });

  it("seeds each variant's stock with its own INITIAL_STOCK entry; product quantity stays 0", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Seeded Shirt",
        price: 15,
        variants: [{ name: "M", initialStock: 10 }, { name: "L", initialStock: 4 }, { name: "XL" }],
      });

    expect(res.status).toBe(201);
    expect(res.body.quantity).toBe(0);
    const quantities = res.body.variants.map((v: { name: string; quantity: number }) => ({
      name: v.name,
      quantity: v.quantity,
    }));
    expect(quantities).toEqual([
      { name: "M", quantity: 10 },
      { name: "L", quantity: 4 },
      { name: "XL", quantity: 0 },
    ]);

    const entries = await prisma.stockLedgerEntry.findMany({
      where: { productId: res.body.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => ({ change: e.quantityChange, reason: e.reason }))).toEqual([
      { change: 10, reason: "INITIAL_STOCK" },
      { change: 4, reason: "INITIAL_STOCK" },
    ]);
    expect(entries.every((e) => e.variantId !== null)).toBe(true);
  });

  it("rejects product-level initialStock combined with variants (400)", async () => {
    const { token } = await createTenantWithOwner();
    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Bad", price: 5, initialStock: 10, variants: [{ name: "M" }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects non-positive initialStock values", async () => {
    const { token } = await createTenantWithOwner();
    for (const initialStock of [0, -3, 1.5]) {
      const res = await request(app)
        .post("/api/dashboard/products")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Bad", price: 5, initialStock });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects INITIAL_STOCK through the manual adjustment endpoint", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);
    const res = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: mainBranch.id, quantityChange: 5, reason: "INITIAL_STOCK" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_STOCK_REASON");
  });
});

describe("ledger referenceId (integration)", () => {
  it("records a referenceId on a restock movement", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);

    const res = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        branchId: mainBranch.id,
        quantityChange: 20,
        reason: "RESTOCK",
        referenceId: "po-123",
      });

    expect(res.status).toBe(200);
    expect(res.body.ledgerEntry.referenceId).toBe("po-123");
    const entry = await prisma.stockLedgerEntry.findFirst({
      where: { productId: product.id },
    });
    expect(entry?.referenceId).toBe("po-123");
  });

  it("leaves referenceId null when not provided", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);
    const res = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: mainBranch.id, quantityChange: 5, reason: "RESTOCK" });
    expect(res.status).toBe(200);
    expect(res.body.ledgerEntry.referenceId).toBeNull();
  });
});

describe("staff attribution on product mutations (integration)", () => {
  async function seedCatalogRowsLocal(storeId: string) {
    const category = await prisma.category.create({
      data: { storeId, name: `Category ${crypto.randomUUID().slice(0, 8)}` },
    });
    const unit = await prisma.unit.create({
      data: { storeId, name: `Unit ${crypto.randomUUID().slice(0, 8)}` },
    });
    return { category, unit };
  }

  async function seedStaffAndCatalog(storeId: string) {
    const { staff } = await createStaffMember(storeId, ["products.manage"]);
    const staffToken = signAccessToken({
      sub: staff.accountId,
      storeId,
      role: "STAFF",
      staffMemberId: staff.id,
    });
    const { category, unit } = await seedCatalogRowsLocal(storeId);
    return { staff, staffToken, category, unit };
  }

  it("attributes product.created/updated/deleted to the acting staff member", async () => {
    const { store } = await createTenantWithOwner();
    const { staff, staffToken, category, unit } = await seedStaffAndCatalog(store.id);

    const created = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({
        name: "Attributed Mug",
        price: 8,
        categoryId: category.id,
        unitId: unit.id,
        coverImageUrl: "https://cdn.example.com/mug.jpg",
      });
    expect(created.status).toBe(201);

    const updated = await request(app)
      .patch(`/api/dashboard/products/${created.body.id}`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ price: 9 });
    expect(updated.status).toBe(200);

    const deleted = await request(app)
      .delete(`/api/dashboard/products/${created.body.id}`)
      .set("Authorization", `Bearer ${staffToken}`);
    expect(deleted.status).toBe(204);

    const entries = await prisma.storeActivityLog.findMany({
      where: { storeId: store.id },
      select: { action: true, staffMemberId: true },
      orderBy: { createdAt: "asc" },
    });
    expect(
      entries.filter((e) =>
        ["product.created", "product.updated", "product.deleted"].includes(e.action),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "product.created", staffMemberId: staff.id }),
        expect.objectContaining({ action: "product.updated", staffMemberId: staff.id }),
        expect.objectContaining({ action: "product.deleted", staffMemberId: staff.id }),
      ]),
    );
  });

  it("attributes publish/unpublish to the acting staff member and leaves owner entries null", async () => {
    const { store, token } = await createTenantWithOwner();
    const { staff, staffToken, category, unit } = await seedStaffAndCatalog(store.id);

    const byStaff = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({
        name: "Attributed Publish",
        price: 8,
        categoryId: category.id,
        unitId: unit.id,
        coverImageUrl: "https://cdn.example.com/mug.jpg",
      });
    expect(byStaff.status).toBe(201);

    const published = await request(app)
      .post(`/api/dashboard/products/${byStaff.body.id}/publish`)
      .set("Authorization", `Bearer ${staffToken}`);
    expect(published.status).toBe(200);

    const unpublished = await request(app)
      .post(`/api/dashboard/products/${byStaff.body.id}/unpublish`)
      .set("Authorization", `Bearer ${staffToken}`);
    expect(unpublished.status).toBe(200);

    const byOwner = await request(app)
      .post(`/api/dashboard/products/${byStaff.body.id}/publish`)
      .set("Authorization", `Bearer ${token}`);
    expect(byOwner.status).toBe(200);

    const entries = await prisma.storeActivityLog.findMany({
      where: { storeId: store.id },
      select: { action: true, staffMemberId: true },
      orderBy: { createdAt: "asc" },
    });
    expect(
      entries.filter((e) => ["product.published", "product.unpublished"].includes(e.action)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "product.published", staffMemberId: staff.id }),
        expect.objectContaining({ action: "product.unpublished", staffMemberId: staff.id }),
        expect.objectContaining({ action: "product.published", staffMemberId: null }),
      ]),
    );
  });
});

describe("product SKU (integration)", () => {
  it("stores an optional trimmed sku on create and returns it on detail", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Mugs", price: 12, sku: "  MUG-001  " });

    expect(res.status).toBe(201);
    expect(res.body.sku).toBe("MUG-001");

    const row = await prisma.product.findUnique({ where: { id: res.body.id } });
    expect(row?.sku).toBe("MUG-001");

    const detail = await request(app)
      .get(`/api/dashboard/products/${res.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.sku).toBe("MUG-001");
  });

  it("creates without a sku when omitted", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "No SKU", price: 5 });

    expect(res.status).toBe(201);
    expect(res.body.sku).toBeNull();
  });

  it("rejects a sku longer than 64 characters", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Long SKU", price: 5, sku: "X".repeat(65) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("updates and clears the sku through PATCH", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, { sku: "OLD-SKU" });

    const updated = await request(app)
      .patch(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sku: "NEW-SKU" });
    expect(updated.status).toBe(200);
    expect(updated.body.sku).toBe("NEW-SKU");

    const cleared = await request(app)
      .patch(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sku: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.sku).toBeNull();
  });

  it("reports salesCount on the list as line items across all order statuses", async () => {
    const { store, token } = await createTenantWithOwner();
    const customer = await prisma.customer.create({
      data: { storeId: store.id, name: "Walk-in" },
    });
    const product = await createProductRow(store.id, { sku: "SOLD-1" });
    const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
      where: { id: store.id },
      select: { defaultBranchId: true },
    });

    const seedOrder = (status: string, lineItemCount: number) =>
      prisma.order.create({
        data: {
          storeId: store.id,
          customerId: customer.id,
          branchId: defaultBranchId!,
          orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
          status: status as never,
          total: 9.99 * lineItemCount,
          lineItems: {
            create: Array.from({ length: lineItemCount }, () => ({
              storeId: store.id,
              productId: product.id,
              quantity: 1,
              unitPriceAtPurchase: 9.99,
            })),
          },
        },
      });

    await seedOrder("PENDING", 2);
    await seedOrder("PAID", 1);

    const res = await request(app)
      .get("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const row = res.body.items.find((item: { id: string }) => item.id === product.id);
    expect(row?.salesCount).toBe(3);

    const detail = await request(app)
      .get(`/api/dashboard/products/${product.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.salesCount).toBeUndefined();
  });
});
