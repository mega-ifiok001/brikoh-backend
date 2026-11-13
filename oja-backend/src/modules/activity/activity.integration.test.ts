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

async function createStaffMember(storeId: string, role: $Enums.StaffRole = "STAFF") {
  const email = `staff-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const staff = await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role, permissions: ["products.manage"] },
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

describe("GET /api/dashboard/activity (integration)", () => {
  it("records product lifecycle events and serves them newest first", async () => {
    const { token } = await createTenantWithOwner();

    const created = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Mug", price: 8 });
    expect(created.status).toBe(201);

    await request(app)
      .patch(`/api/dashboard/products/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Renamed Mug", price: 9 });

    const res = await request(app)
      .get("/api/dashboard/activity")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const actions = res.body.items.map((entry: { action: string }) => entry.action);
    expect(actions).toEqual(["product.updated", "product.created"]);
    expect(res.body.items[1]!.detail).toMatchObject({ productId: created.body.id });
  });

  it("records stock adjustments (manual and variant) with staff attribution", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const { staff } = await createStaffMember(store.id);
    const staffToken = signAccessToken({
      sub: staff.accountId,
      storeId: store.id,
      role: "STAFF",
      staffMemberId: staff.id,
    });

    const plain = await prisma.product.create({
      data: { storeId: store.id, name: "Mug", price: 8, quantity: 0 },
    });
    const variantProduct = await prisma.product.create({
      data: { storeId: store.id, name: "Shirt", price: 15, quantity: 0 },
    });
    const variant = await prisma.productVariant.create({
      data: { storeId: store.id, productId: variantProduct.id, name: "M" },
    });
    await prisma.branchStock.create({
      data: {
        storeId: store.id,
        branchId: mainBranch.id,
        productId: plain.id,
        variantId: null,
        quantity: 0,
      },
    });
    await prisma.branchStock.create({
      data: {
        storeId: store.id,
        branchId: mainBranch.id,
        productId: variantProduct.id,
        variantId: variant.id,
        quantity: 0,
      },
    });

    await request(app)
      .post(`/api/dashboard/products/${plain.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ branchId: mainBranch.id, quantityChange: 5, reason: "RESTOCK" });
    await request(app)
      .post(`/api/dashboard/products/${variantProduct.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({
        branchId: mainBranch.id,
        variantId: variant.id,
        quantityChange: 3,
        reason: "RESTOCK",
      });

    const res = await request(app)
      .get("/api/dashboard/activity")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const entries = res.body.items as {
      action: string;
      staffMemberId: string | null;
      detail: Record<string, unknown>;
    }[];
    expect(entries).toHaveLength(2);
    expect(entries[0]!.action).toBe("stock.adjusted");
    expect(entries[0]!.detail).toMatchObject({ variantId: variant.id, quantityChange: 3 });
    expect(entries[0]!.staffMemberId).toBe(staff.id);
    expect(entries[1]!.detail).toMatchObject({ variantId: null, quantityChange: 5 });
  });

  it("records staff.role.updated and staff.removed, but not permission-only changes", async () => {
    const { store, token } = await createTenantWithOwner();
    const { staff } = await createStaffMember(store.id);

    const permissionOnly = await request(app)
      .patch(`/api/dashboard/staff/${staff.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ permissions: ["products.manage", "analytics.manage"] });
    expect(permissionOnly.status).toBe(200);

    const roleChange = await request(app)
      .patch(`/api/dashboard/staff/${staff.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "MANAGER" });
    expect(roleChange.status).toBe(200);

    const removed = await request(app)
      .delete(`/api/dashboard/staff/${staff.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(removed.status).toBe(204);

    const res = await request(app)
      .get("/api/dashboard/activity")
      .set("Authorization", `Bearer ${token}`);

    const actions = res.body.items.map((entry: { action: string }) => entry.action);
    expect(actions).toEqual(["staff.removed", "staff.role.updated"]);
    expect(res.body.items[1]!.detail).toMatchObject({ from: "STAFF", to: "MANAGER" });
  });

  it("records staff.joined when an invite is accepted", async () => {
    const { store, token } = await createTenantWithOwner();

    const invite = await request(app)
      .post("/api/dashboard/staff/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: `new-${crypto.randomUUID()}@example.com`, role: "STAFF" });
    expect(invite.status).toBe(201);

    // The invite token is emailed, never returned by the API — read it
    // from the DB like the acceptance flow's recipient would.
    const pending = await prisma.inviteToken.findFirstOrThrow({
      where: { storeId: store.id, status: "PENDING" },
    });

    const accept = await request(app)
      .post("/api/public/auth/accept-invite")
      .send({ token: pending.token, password: "password-123" });
    expect(accept.status).toBe(201);

    const res = await request(app)
      .get("/api/dashboard/activity")
      .set("Authorization", `Bearer ${token}`);

    const entries = res.body.items as { action: string; detail: Record<string, unknown> }[];
    expect(entries[0]!.action).toBe("staff.joined");
    expect(entries[0]!.detail).toMatchObject({ role: "STAFF" });
  });

  it("is owner-only: staff tokens get 403 and anonymous requests get 401", async () => {
    const { store } = await createTenantWithOwner();
    const { staff } = await createStaffMember(store.id);
    const staffToken = signAccessToken({
      sub: staff.accountId,
      storeId: store.id,
      role: "STAFF",
      staffMemberId: staff.id,
    });

    const asStaff = await request(app)
      .get("/api/dashboard/activity")
      .set("Authorization", `Bearer ${staffToken}`);
    expect(asStaff.status).toBe(403);

    const anonymous = await request(app).get("/api/dashboard/activity");
    expect(anonymous.status).toBe(401);
  });

  it("filters by staffMemberId and the UTC window, and paginates with a cursor", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const { staff } = await createStaffMember(store.id);
    const staffToken = signAccessToken({
      sub: staff.accountId,
      storeId: store.id,
      role: "STAFF",
      staffMemberId: staff.id,
    });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Mug", price: 8 },
    });
    await prisma.branchStock.create({
      data: {
        storeId: store.id,
        branchId: mainBranch.id,
        productId: product.id,
        variantId: null,
        quantity: 0,
      },
    });

    // owner action (no staffMemberId)
    await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: mainBranch.id, quantityChange: 1, reason: "RESTOCK" });
    // staff action
    await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ branchId: mainBranch.id, quantityChange: 2, reason: "RESTOCK" });

    const byStaff = await request(app)
      .get(`/api/dashboard/activity?staffMemberId=${staff.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(byStaff.status).toBe(200);
    expect(byStaff.body.total).toBe(1);
    expect(byStaff.body.items[0]!.staffMemberId).toBe(staff.id);

    const beforeAll = await request(app)
      .get("/api/dashboard/activity?start=2026-01-01T00:00:00Z")
      .set("Authorization", `Bearer ${token}`);
    expect(beforeAll.status).toBe(200);
    expect(beforeAll.body.total).toBe(2);

    const futureOnly = await request(app)
      .get("/api/dashboard/activity?start=2027-01-01T00:00:00Z&end=2027-12-31T00:00:00Z")
      .set("Authorization", `Bearer ${token}`);
    expect(futureOnly.status).toBe(200);
    expect(futureOnly.body.total).toBe(0);

    const page1 = await request(app)
      .get("/api/dashboard/activity?limit=1")
      .set("Authorization", `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.nextCursor).toBeTypeOf("string");

    const page2 = await request(app)
      .get(`/api/dashboard/activity?limit=1&cursor=${page1.body.nextCursor}`)
      .set("Authorization", `Bearer ${token}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();

    const seen = [...page1.body.items, ...page2.body.items];
    expect(new Set(seen.map((entry: { id: string }) => entry.id)).size).toBe(2);

    const stale = await request(app)
      .get(`/api/dashboard/activity?cursor=${crypto.randomUUID()}`)
      .set("Authorization", `Bearer ${token}`);
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe("VALIDATION_ERROR");
  });
});
