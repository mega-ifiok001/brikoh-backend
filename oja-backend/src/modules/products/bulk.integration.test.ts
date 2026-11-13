import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";
import type { $Enums, Prisma } from "../../../generated/prisma/client.js";

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

async function createProductRow(
  storeId: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { defaultBranchId: true },
  });
  const product = await prisma.product.create({
    data: {
      storeId,
      name,
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
      quantity: 10,
    },
  });
  return product;
}

async function createTicket(
  storeId: string,
  rows: Prisma.ProductImportRowCreateWithoutImportInput[],
) {
  return prisma.productImport.create({
    data: {
      storeId,
      createdByStaffId: null,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      rows: { create: rows },
    },
    include: { rows: true },
  });
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
    DELETE FROM "ProductImportRow"; DELETE FROM "ProductImport";
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

describe("POST /api/dashboard/products/bulk/import (integration)", () => {
  it("previews valid rows without writing any product", async () => {
    const { store, token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/products/bulk/import")
      .set("Authorization", `Bearer ${token}`)
      .send({
        rows: [
          { name: "  Ground Coffee 500g  ", price: 12.5, costPrice: "3.25", initialStock: 20 },
          { name: "Cold Brew", price: "8" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ new: 2, duplicates: 0, errors: 0 });
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0]).toMatchObject({
      rowNumber: 1,
      status: "new",
      errors: [],
      existingProductId: null,
      product: { name: "Ground Coffee 500g", price: "12.50", costPrice: "3.25", initialStock: 20 },
    });
    expect(res.body.rows[1]).toMatchObject({ status: "new", product: { price: "8.00" } });
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());

    expect(await prisma.product.count({ where: { storeId: store.id } })).toBe(0);
    const ticket = await prisma.productImport.findFirst({ where: { storeId: store.id } });
    expect(ticket?.status).toBe("PENDING");
    expect(await prisma.productImportRow.count({ where: { importId: ticket!.id } })).toBe(2);
  });

  it("flags duplicates of existing products case-insensitively", async () => {
    const { store, token } = await createTenantWithOwner();
    await createProductRow(store.id, "cold brew 500ml");

    const res = await request(app)
      .post("/api/dashboard/products/bulk/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ rows: [{ name: "Cold Brew 500ml", price: 8 }] });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ new: 0, duplicates: 1, errors: 0 });
    expect(res.body.rows[0]).toMatchObject({
      status: "duplicate",
      existingName: "cold brew 500ml",
    });
    expect(res.body.rows[0].existingProductId).toBeTruthy();
  });

  it("flags the later row of an intra-import collision and per-row errors", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/products/bulk/import")
      .set("Authorization", `Bearer ${token}`)
      .send({
        rows: [
          { name: "Cafe", price: 3 },
          { name: "cafe", price: 4 },
          { name: "  ", price: 5 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ new: 1, duplicates: 1, errors: 1 });
    expect(res.body.rows[1]).toMatchObject({ status: "duplicate", existingProductId: null });
    expect(res.body.rows[2]).toMatchObject({ status: "error" });
    expect(res.body.rows[2].errors).toContain("name is required");
  });

  it("flags rows referencing a cross-tenant category", async () => {
    const { token } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    const otherCategory = await prisma.category.create({
      data: { storeId: other.store.id, name: "Other Cat" },
    });

    const res = await request(app)
      .post("/api/dashboard/products/bulk/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ rows: [{ name: "Tea", price: 2, categoryId: otherCategory.id }] });

    expect(res.status).toBe(200);
    expect(res.body.rows[0]!.status).toBe("error");
    expect(res.body.rows[0]!.errors.some((e: string) => e.includes("categoryId"))).toBe(true);
  });

  it("rejects more than 500 rows", async () => {
    const { token } = await createTenantWithOwner();
    const rows = Array.from({ length: 501 }, (_, i) => ({ name: `p-${i}`, price: 1 }));

    const res = await request(app)
      .post("/api/dashboard/products/bulk/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ rows });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/dashboard/products/bulk/confirm (integration)", () => {
  it("creates products with eager branch stock, INITIAL_STOCK ledger entries, and activity", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();

    const imported = await request(app)
      .post("/api/dashboard/products/bulk/import")
      .set("Authorization", `Bearer ${token}`)
      .send({
        rows: [
          { name: "Cold Brew 500ml", price: 8, initialStock: 7 },
          { name: "Plain Tea", price: 4 },
        ],
      });
    expect(imported.status).toBe(200);

    const res = await request(app)
      .post("/api/dashboard/products/bulk/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ importId: imported.body.importId });

    expect(res.status).toBe(200);
    expect(res.body.created.map((p: { name: string }) => p.name)).toEqual([
      "Cold Brew 500ml",
      "Plain Tea",
    ]);
    expect(res.body.failed).toEqual([]);
    expect(res.body.skipped).toEqual([]);

    const brew = await prisma.product.findFirstOrThrow({ where: { name: "Cold Brew 500ml" } });
    expect(brew.quantity).toBe(7);
    const tea = await prisma.product.findFirstOrThrow({ where: { name: "Plain Tea" } });
    expect(tea.quantity).toBe(0);

    const brewStock = await prisma.branchStock.findFirstOrThrow({
      where: { storeId: store.id, branchId: mainBranch.id, productId: brew.id, variantId: null },
    });
    expect(brewStock.quantity).toBe(7);
    expect(
      await prisma.branchStock.count({
        where: { storeId: store.id, branchId: mainBranch.id, productId: tea.id },
      }),
    ).toBe(1);

    const seeds = await prisma.stockLedgerEntry.findMany({
      where: { storeId: store.id, reason: "INITIAL_STOCK" },
    });
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.quantityChange).toBe(7);
    expect(seeds[0]!.productId).toBe(brew.id);

    const activity = await prisma.storeActivityLog.findFirstOrThrow({
      where: { storeId: store.id, action: "bulk.imported" },
    });
    expect(activity.detail).toMatchObject({ created: 2, overwritten: 0, skipped: 0, failed: 0 });
  });

  it("overwrites an explicitly resolved duplicate and never touches stock", async () => {
    const { store, token } = await createTenantWithOwner();
    const existing = await createProductRow(store.id, "Cold Brew 500ml");

    const imported = await request(app)
      .post("/api/dashboard/products/bulk/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ rows: [{ name: "Cold Brew 500ml", price: 9, initialStock: 999 }] });
    expect(imported.body.rows[0]!.status).toBe("duplicate");

    const res = await request(app)
      .post("/api/dashboard/products/bulk/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ importId: imported.body.importId, resolveDuplicates: { "1": "overwrite" } });

    expect(res.status).toBe(200);
    expect(res.body.overwritten).toHaveLength(1);
    const updated = await prisma.product.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.price.toString()).toBe("9");
    expect(updated.quantity).toBe(10);
    expect(await prisma.stockLedgerEntry.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("skips duplicates that are not resolved, leaving them untouched", async () => {
    const { store, token } = await createTenantWithOwner();
    await createProductRow(store.id, "Cold Brew 500ml");
    const imported = await request(app)
      .post("/api/dashboard/products/bulk/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ rows: [{ name: "Cold Brew 500ml", price: 8 }] });
    expect(imported.body.rows[0]!.status).toBe("duplicate");

    const res = await request(app)
      .post("/api/dashboard/products/bulk/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ importId: imported.body.importId });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toEqual([1]);
    expect(res.body.created).toEqual([]);
    expect(await prisma.product.count({ where: { storeId: store.id } })).toBe(1);
  });

  it("400s when an error row is listed in resolveDuplicates", async () => {
    const { token } = await createTenantWithOwner();
    const imported = await request(app)
      .post("/api/dashboard/products/bulk/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ rows: [{ name: "  ", price: 5 }] });
    expect(imported.body.rows[0]!.status).toBe("error");

    const res = await request(app)
      .post("/api/dashboard/products/bulk/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ importId: imported.body.importId, resolveDuplicates: { "1": "skip" } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("404s for unknown, cross-tenant, expired, and already-confirmed tickets", async () => {
    const { store, token } = await createTenantWithOwner();
    const other = await createTenantWithOwner();

    const unknown = await request(app)
      .post("/api/dashboard/products/bulk/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ importId: crypto.randomUUID() });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("IMPORT_NOT_FOUND");

    const otherTicket = await createTicket(other.store.id, []);
    const crossTenant = await request(app)
      .post("/api/dashboard/products/bulk/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ importId: otherTicket.id });
    expect(crossTenant.status).toBe(404);

    const expired = await prisma.productImport.create({
      data: {
        storeId: store.id,
        status: "PENDING",
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const expiredRes = await request(app)
      .post("/api/dashboard/products/bulk/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ importId: expired.id });
    expect(expiredRes.status).toBe(404);

    const confirmed = await prisma.productImport.create({
      data: {
        storeId: store.id,
        status: "CONFIRMED",
        expiresAt: new Date(Date.now() + 1000),
        confirmedAt: new Date(),
      },
    });
    const confirmedRes = await request(app)
      .post("/api/dashboard/products/bulk/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ importId: confirmed.id });
    expect(confirmedRes.status).toBe(404);
  });

  it("409 DUPLICATE_NAME when a product with the same name appeared after the import", async () => {
    const { store, token } = await createTenantWithOwner();
    const imported = await request(app)
      .post("/api/dashboard/products/bulk/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ rows: [{ name: "Cold Brew 500ml", price: 8 }] });
    expect(imported.body.rows[0]!.status).toBe("new");
    await createProductRow(store.id, "Cold Brew 500ml");

    const res = await request(app)
      .post("/api/dashboard/products/bulk/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ importId: imported.body.importId });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DUPLICATE_NAME");
    expect(await prisma.product.count({ where: { storeId: store.id } })).toBe(1);
  });

  it("409 PRODUCT_LIMIT_REACHED rolls the whole import back", async () => {
    const { store, token } = await createTenantWithOwner();
    await prisma.subscription.create({
      data: {
        storeId: store.id,
        tier: "STARTER",
        status: "ACTIVE",
        currentPeriodStart: new Date(Date.now() - 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        staffCap: null,
        locationCap: null,
        productCap: 1,
        orderCap: null,
      },
    });
    await createProductRow(store.id, "Existing Mug");
    const cap = await prisma.subscription.findFirstOrThrow({ where: { storeId: store.id } });
    await prisma.store.update({ where: { id: store.id }, data: { subscriptionId: cap.id } });

    const imported = await request(app)
      .post("/api/dashboard/products/bulk/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ rows: [{ name: "Over Cap Tea", price: 4 }] });
    expect(imported.body.rows[0]!.status).toBe("new");

    const res = await request(app)
      .post("/api/dashboard/products/bulk/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ importId: imported.body.importId });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PRODUCT_LIMIT_REACHED");
    expect(await prisma.product.count({ where: { storeId: store.id } })).toBe(1);
    const ticket = await prisma.productImport.findFirstOrThrow({
      where: { id: imported.body.importId },
    });
    expect(ticket.status).toBe("PENDING");
  });

  it("requires products.manage permission", async () => {
    const { store } = await createTenantWithOwner();
    const { token: noPermToken } = await createStaffMember(store.id, []);
    const { token: okToken } = await createStaffMember(store.id, ["products.manage"]);

    const forbidden = await request(app)
      .post("/api/dashboard/products/bulk/import")
      .set("Authorization", `Bearer ${noPermToken}`)
      .send({ rows: [{ name: "Tea", price: 2 }] });
    expect(forbidden.status).toBe(403);

    const allowed = await request(app)
      .post("/api/dashboard/products/bulk/import")
      .set("Authorization", `Bearer ${okToken}`)
      .send({ rows: [{ name: "Tea", price: 2 }] });
    expect(allowed.status).toBe(200);
  });
});
