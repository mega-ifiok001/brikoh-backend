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
  const token = signAccessToken({
    sub: account.id,
    storeId,
    role,
    staffMemberId: staff.id,
  });
  return { account, staff, token };
}

async function createProductRow(
  storeId: string,
  branchId: string,
  overrides: Record<string, unknown> = {},
) {
  const product = await prisma.product.create({
    data: {
      storeId,
      name: `Product ${crypto.randomUUID().slice(0, 8)}`,
      price: 9.99,
      quantity: (overrides.quantity as number | undefined) ?? 10,
      ...overrides,
    },
  });
  await prisma.branchStock.create({
    data: {
      storeId,
      branchId,
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

describe("branches CRUD (integration)", () => {
  it("creates a branch for the authenticated tenant", async () => {
    const { store, token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/branches")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Lekki", address: "Lagos, Nigeria" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      storeId: store.id,
      name: "Lekki",
      address: "Lagos, Nigeria",
      isDefault: false,
    });
    expect(await prisma.branch.count({ where: { storeId: store.id } })).toBe(2);
  });

  it("rejects a duplicate branch name with 409 BRANCH_EXISTS", async () => {
    const { token } = await createTenantWithOwner();

    await request(app)
      .post("/api/dashboard/branches")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Lekki" });

    const res = await request(app)
      .post("/api/dashboard/branches")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Lekki" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BRANCH_EXISTS");
  });

  it("updates a branch name and address", async () => {
    const { token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/branches")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Old Name" });

    const res = await request(app)
      .patch(`/api/dashboard/branches/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "New Name", address: "Abuja" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.body.id, name: "New Name", address: "Abuja" });
  });

  it("404s updates for unknown or cross-tenant branches", async () => {
    const { token } = await createTenantWithOwner();
    const { store: foreign } = await createTenantWithOwner();
    const foreignBranch = await prisma.branch.create({
      data: { storeId: foreign.id, name: "Foreign" },
    });

    const missing = await request(app)
      .patch("/api/dashboard/branches/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "X" });
    expect(missing.status).toBe(404);

    const crossTenant = await request(app)
      .patch(`/api/dashboard/branches/${foreignBranch.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "X" });
    expect(crossTenant.status).toBe(404);
  });

  it("makes a branch the default and clears it from the old one", async () => {
    const { store, token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/branches")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Lekki" });

    const res = await request(app)
      .put(`/api/dashboard/branches/${created.body.id}/default`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.isDefault).toBe(true);
    const storeRow = await prisma.store.findUnique({ where: { id: store.id } });
    expect(storeRow?.defaultBranchId).toBe(created.body.id);
  });

  it("deletes an empty non-default branch", async () => {
    const { token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/branches")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Lekki" });

    const res = await request(app)
      .delete(`/api/dashboard/branches/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: created.body.id });
    expect(await prisma.branch.findUnique({ where: { id: created.body.id } })).toBeNull();
  });

  it("rejects deleting the default branch (409 DEFAULT_BRANCH)", async () => {
    const { mainBranch, token } = await createTenantWithOwner();

    const res = await request(app)
      .delete(`/api/dashboard/branches/${mainBranch.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DEFAULT_BRANCH");
  });

  it("rejects deleting a branch that still holds stock (409 BRANCH_HAS_STOCK)", async () => {
    const { store, token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/branches")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Lekki" });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Stocked", price: 5, quantity: 5 },
    });
    await prisma.branchStock.create({
      data: {
        storeId: store.id,
        branchId: created.body.id,
        productId: product.id,
        variantId: null,
        quantity: 5,
      },
    });

    const res = await request(app)
      .delete(`/api/dashboard/branches/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BRANCH_HAS_STOCK");
  });

  it("rejects deleting a branch with order history (409 BRANCH_HAS_ORDERS)", async () => {
    const { store, token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/branches")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Lekki" });
    const customer = await prisma.customer.create({
      data: { storeId: store.id, name: "Buyer" },
    });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Sold", price: 5, quantity: 0 },
    });
    await prisma.order.create({
      data: {
        storeId: store.id,
        customerId: customer.id,
        branchId: created.body.id,
        orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
        total: 5,
        lineItems: {
          create: {
            storeId: store.id,
            productId: product.id,
            quantity: 1,
            unitPriceAtPurchase: 5,
          },
        },
      },
    });

    const res = await request(app)
      .delete(`/api/dashboard/branches/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BRANCH_HAS_ORDERS");
  });

  it("attributes branch CRUD activity to the acting staff member", async () => {
    const { store, token } = await createTenantWithOwner();
    const { staff } = await createStaffMember(store.id, ["locations.manage", "products.manage"]);
    const staffToken = signAccessToken({
      sub: staff.accountId,
      storeId: store.id,
      role: "STAFF",
      staffMemberId: staff.id,
    });

    const created = await request(app)
      .post("/api/dashboard/branches")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ name: "Lekki" });
    expect(created.status).toBe(201);

    const updated = await request(app)
      .patch(`/api/dashboard/branches/${created.body.id}`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ name: "Lekki Phase 2" });
    expect(updated.status).toBe(200);

    const madeDefault = await request(app)
      .put(`/api/dashboard/branches/${created.body.id}/default`)
      .set("Authorization", `Bearer ${staffToken}`);
    expect(madeDefault.status).toBe(200);

    const warehouse = await request(app)
      .post("/api/dashboard/branches")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ name: "Warehouse" });
    expect(warehouse.status).toBe(201);
    await request(app)
      .put(`/api/dashboard/branches/${warehouse.body.id}/default`)
      .set("Authorization", `Bearer ${staffToken}`);
    expect(madeDefault.status).toBe(200);

    const deleted = await request(app)
      .delete(`/api/dashboard/branches/${created.body.id}`)
      .set("Authorization", `Bearer ${staffToken}`);
    expect(deleted.status).toBe(200);

    const byOwner = await request(app)
      .post("/api/dashboard/branches")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Owner Branch" });
    expect(byOwner.status).toBe(201);

    const entries = await prisma.storeActivityLog.findMany({
      where: { storeId: store.id },
      select: { action: true, staffMemberId: true },
      orderBy: { createdAt: "asc" },
    });
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "branch.created", staffMemberId: staff.id }),
        expect.objectContaining({ action: "branch.updated", staffMemberId: staff.id }),
        expect.objectContaining({ action: "branch.default_changed", staffMemberId: staff.id }),
        expect.objectContaining({ action: "branch.deleted", staffMemberId: staff.id }),
        expect.objectContaining({ action: "branch.created", staffMemberId: null }),
      ]),
    );
  });
});

describe("stock transfers (integration)", () => {
  it("moves stock between branches with both ledger legs and attributed activity", async () => {
    const { store, mainBranch } = await createTenantWithOwner();
    const { staff } = await createStaffMember(store.id, ["locations.manage", "products.manage"]);
    const staffToken = signAccessToken({
      sub: staff.accountId,
      storeId: store.id,
      role: "STAFF",
      staffMemberId: staff.id,
    });
    const product = await createProductRow(store.id, mainBranch.id, { quantity: 10 });
    const branch = await prisma.branch.create({ data: { storeId: store.id, name: "Lekki" } });

    const res = await request(app)
      .post("/api/dashboard/branches/transfers")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({
        productId: product.id,
        sourceBranchId: mainBranch.id,
        destinationBranchId: branch.id,
        quantity: 3,
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      productId: product.id,
      quantity: 3,
      sourceBranch: { branchId: mainBranch.id, quantityChange: -3, stockAfter: 7 },
      destinationBranch: { branchId: branch.id, quantityChange: 3, stockAfter: 3 },
    });

    const entries = await prisma.stockLedgerEntry.findMany({
      where: { productId: product.id },
      orderBy: { createdAt: "asc" },
    });
    expect(entries.map((e) => e.reason)).toEqual(["TRANSFER_OUT", "TRANSFER_IN"]);
    expect(entries.every((e) => e.performedByStaffId === staff.id)).toBe(true);

    const activity = await prisma.storeActivityLog.findMany({
      where: { storeId: store.id },
      select: { action: true, staffMemberId: true },
    });
    const transferred = activity.filter((a) => a.action === "stock.transferred");
    expect(transferred).toHaveLength(1);
    expect(transferred[0]).toMatchObject({ staffMemberId: staff.id });
  });

  it("rejects a transfer with an insufficient source branch (409 INSUFFICIENT_STOCK)", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, mainBranch.id, { quantity: 2 });
    const branch = await prisma.branch.create({ data: { storeId: store.id, name: "Lekki" } });

    const res = await request(app)
      .post("/api/dashboard/branches/transfers")
      .set("Authorization", `Bearer ${token}`)
      .send({
        productId: product.id,
        sourceBranchId: mainBranch.id,
        destinationBranchId: branch.id,
        quantity: 5,
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await prisma.stockLedgerEntry.count({ where: { productId: product.id } })).toBe(0);
    expect(await prisma.storeActivityLog.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("rejects same-branch transfers (400 TRANSFER_SAME_BRANCH)", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, mainBranch.id);

    const res = await request(app)
      .post("/api/dashboard/branches/transfers")
      .set("Authorization", `Bearer ${token}`)
      .send({
        productId: product.id,
        sourceBranchId: mainBranch.id,
        destinationBranchId: mainBranch.id,
        quantity: 1,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TRANSFER_SAME_BRANCH");
  });

  it("404s transfers naming an unknown source or destination branch", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id, mainBranch.id);

    const res = await request(app)
      .post("/api/dashboard/branches/transfers")
      .set("Authorization", `Bearer ${token}`)
      .send({
        productId: product.id,
        sourceBranchId: mainBranch.id,
        destinationBranchId: "00000000-0000-0000-0000-000000000000",
        quantity: 1,
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("BRANCH_NOT_FOUND");
  });
});
