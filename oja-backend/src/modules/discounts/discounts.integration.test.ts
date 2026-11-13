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
  const branch = await prisma.branch.create({
    data: { storeId: store.id, name: "Main Branch", address: "Lagos, Nigeria" },
  });
  await prisma.store.update({ where: { id: store.id }, data: { defaultBranchId: branch.id } });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  const token = signAccessToken({ sub: account.id, storeId: store.id, role: "OWNER" });
  return { account, store, mainBranch: branch, token };
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
    DELETE FROM "RefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
    DELETE FROM "CreditRepayment"; DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

describe("discounts CRUD (integration)", () => {
  it("creates, lists, reads, updates, and deletes a discount with activity", async () => {
    const { store, token } = await createTenantWithOwner();

    const created = await request(app)
      .post("/api/dashboard/discounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Grand Opening 10%", type: "PERCENTAGE", value: "10", code: "grand-opening" });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Grand Opening 10%",
      type: "PERCENTAGE",
      value: "10.00",
      code: "GRAND-OPENING",
      isActive: true,
    });

    const list = await request(app)
      .get("/api/dashboard/discounts")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].value).toBe("10.00");

    const detail = await request(app)
      .get(`/api/dashboard/discounts/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.code).toBe("GRAND-OPENING");

    const updated = await request(app)
      .put(`/api/dashboard/discounts/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ isActive: false });
    expect(updated.status).toBe(200);
    expect(updated.body.isActive).toBe(false);

    const activity = await prisma.storeActivityLog.findFirst({
      where: { storeId: store.id, action: "discount.updated" },
    });
    expect(activity).not.toBeNull();

    const deleted = await request(app)
      .delete(`/api/dashboard/discounts/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    expect(await prisma.discount.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("rejects a duplicate code with 409 DISCOUNT_CODE_TAKEN", async () => {
    const { store, token } = await createTenantWithOwner();
    await prisma.discount.create({
      data: { storeId: store.id, name: "A", type: "FIXED", value: 5, code: "SAME" },
    });

    const res = await request(app)
      .post("/api/dashboard/discounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "B", type: "FIXED", value: "5", code: "same" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DISCOUNT_CODE_TAKEN");
  });

  it("rejects a PERCENTAGE over 100 with 400 VALIDATION_ERROR", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/discounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Too big", type: "PERCENTAGE", value: "150" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("filters by isActive and type", async () => {
    const { store, token } = await createTenantWithOwner();
    await prisma.discount.create({
      data: { storeId: store.id, name: "Active fixed", type: "FIXED", value: 5, isActive: true },
    });
    await prisma.discount.create({
      data: {
        storeId: store.id,
        name: "Inactive percent",
        type: "PERCENTAGE",
        value: 10,
        isActive: false,
      },
    });

    const res = await request(app)
      .get("/api/dashboard/discounts?isActive=true&type=FIXED")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe("Active fixed");
  });

  it("requires the discounts.manage permission", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id, ["orders.manage"]);

    const res = await request(app)
      .post("/api/dashboard/discounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "A", type: "FIXED", value: "5" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });
});

describe("discounts + sale flows (integration)", () => {
  it("applies a code discount to a POS sale and persists discountId/discountAmount", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const discount = await prisma.discount.create({
      data: { storeId: store.id, name: "Ten off", type: "FIXED", value: 10, code: "TEN-OFF" },
    });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Bottle", price: 25, quantity: 100, status: "PUBLISHED" },
    });
    await prisma.branchStock.create({
      data: { storeId: store.id, branchId: mainBranch.id, productId: product.id, quantity: 100 },
    });
    const customer = await prisma.customer.create({
      data: { storeId: store.id, name: "Ade", email: `ade-${crypto.randomUUID()}@example.com` },
    });

    const res = await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        items: [{ productId: product.id, quantity: 2 }],
        paymentMethod: "CASH",
        discountCode: "ten-off",
      });

    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({
      total: "40.00",
      discountAmount: "10.00",
      discountId: discount.id,
      amountPaid: "40.00",
    });
  });

  it("auto-applies a group discount to a POS sale for group members", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const discount = await prisma.discount.create({
      data: { storeId: store.id, name: "Members 10%", type: "PERCENTAGE", value: 10 },
    });
    const group = await prisma.customerGroup.create({
      data: { storeId: store.id, name: "Wholesale", discountId: discount.id },
    });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Bottle", price: 20, quantity: 100, status: "PUBLISHED" },
    });
    await prisma.branchStock.create({
      data: { storeId: store.id, branchId: mainBranch.id, productId: product.id, quantity: 100 },
    });
    const customer = await prisma.customer.create({
      data: {
        storeId: store.id,
        name: "Ade",
        email: `ade-${crypto.randomUUID()}@example.com`,
        groupId: group.id,
      },
    });

    const res = await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: "CASH",
      });

    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({
      total: "18.00",
      discountAmount: "2.00",
      discountId: discount.id,
    });
  });
});
