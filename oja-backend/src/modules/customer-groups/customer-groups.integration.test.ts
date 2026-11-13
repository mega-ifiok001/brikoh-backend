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
  await prisma.branch.create({
    data: { storeId: store.id, name: "Main Branch", address: "Lagos, Nigeria" },
  });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  const token = signAccessToken({ sub: account.id, storeId: store.id, role: "OWNER" });
  return { account, store, token };
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

async function createDiscount(storeId: string, code = "WHOLESALE-5") {
  return prisma.discount.create({
    data: { storeId, name: "Wholesale 5%", type: "PERCENTAGE", value: 5, code },
  });
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

describe("customer groups CRUD (integration)", () => {
  it("creates, lists, reads, updates, and deletes a group with activity", async () => {
    const { store, token } = await createTenantWithOwner();

    const created = await request(app)
      .post("/api/dashboard/customer-groups")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Wholesale", description: "Resellers" });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Wholesale",
      description: "Resellers",
      memberCount: 0,
      discount: null,
    });

    const list = await request(app)
      .get("/api/dashboard/customer-groups")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].name).toBe("Wholesale");

    const detail = await request(app)
      .get(`/api/dashboard/customer-groups/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.group.name).toBe("Wholesale");
    expect(detail.body.members).toEqual([]);

    const updated = await request(app)
      .put(`/api/dashboard/customer-groups/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Wholesale (New)" });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("Wholesale (New)");

    const activity = await prisma.storeActivityLog.findFirst({
      where: { storeId: store.id, action: "customerGroup.updated" },
    });
    expect(activity).not.toBeNull();

    const deleted = await request(app)
      .delete(`/api/dashboard/customer-groups/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    expect(await prisma.customerGroup.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("rejects a duplicate group name with 409 GROUP_NAME_TAKEN", async () => {
    const { store, token } = await createTenantWithOwner();
    await prisma.customerGroup.create({ data: { storeId: store.id, name: "Wholesale" } });

    const res = await request(app)
      .post("/api/dashboard/customer-groups")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Wholesale" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("GROUP_NAME_TAKEN");
  });

  it("refuses to delete a group with assigned customers (409 GROUP_HAS_CUSTOMERS)", async () => {
    const { store, token } = await createTenantWithOwner();
    const group = await prisma.customerGroup.create({
      data: { storeId: store.id, name: "Wholesale" },
    });
    await prisma.customer.create({
      data: {
        storeId: store.id,
        name: "Ade Okafor",
        email: `ade-${crypto.randomUUID()}@example.com`,
        groupId: group.id,
      },
    });

    const res = await request(app)
      .delete(`/api/dashboard/customer-groups/${group.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("GROUP_HAS_CUSTOMERS");
  });

  it("attaches a tenant-owned discount to a group and lists it embedded", async () => {
    const { store, token } = await createTenantWithOwner();
    const discount = await createDiscount(store.id);

    const created = await request(app)
      .post("/api/dashboard/customer-groups")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Wholesale", discountId: discount.id });

    expect(created.status).toBe(201);
    expect(created.body.discount).toEqual({
      id: discount.id,
      name: "Wholesale 5%",
      type: "PERCENTAGE",
      value: "5.00",
    });
  });

  it("rejects attaching a cross-tenant discount with 404 DISCOUNT_NOT_FOUND", async () => {
    const { store, token } = await createTenantWithOwner();
    const otherStore = await prisma.store.create({
      data: {
        name: "Other",
        subdomain: `o-${crypto.randomUUID().slice(0, 8)}`,
        businessType: "OTHER",
        location: "Lagos",
        businessPhone: "+234 801 234 5678",
      },
    });
    const foreignDiscount = await createDiscount(otherStore.id);

    const res = await request(app)
      .post("/api/dashboard/customer-groups")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Wholesale", discountId: foreignDiscount.id });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("DISCOUNT_NOT_FOUND");
    void store;
  });

  it("requires the customers.manage permission", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id, ["orders.manage"]);

    const res = await request(app)
      .post("/api/dashboard/customer-groups")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Wholesale" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });
});

describe("customer groups + customers (integration)", () => {
  it("lands new customers without a group in the default General group", async () => {
    const { store, token } = await createTenantWithOwner();

    const created = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade Okafor" });

    expect(created.status).toBe(201);
    expect(created.body.group).toEqual({ id: expect.any(String), name: "General" });

    const general = await prisma.customerGroup.findFirst({
      where: { storeId: store.id, name: "General" },
    });
    expect(general).not.toBeNull();
    expect(
      await prisma.customer.count({ where: { storeId: store.id, groupId: general?.id } }),
    ).toBe(1);
  });

  it("assigns a customer to an explicit group on create and via update", async () => {
    const { store, token } = await createTenantWithOwner();
    const group = await prisma.customerGroup.create({
      data: { storeId: store.id, name: "Wholesale" },
    });

    const created = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade", groupId: group.id });
    expect(created.status).toBe(201);
    expect(created.body.group).toEqual({ id: group.id, name: "Wholesale" });

    const moved = await request(app)
      .put(`/api/dashboard/customers/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ groupId: null });
    expect(moved.status).toBe(200);
    expect(moved.body.group).toBeNull();
  });

  it("rejects assigning a cross-tenant group with 404 CUSTOMER_GROUP_NOT_FOUND", async () => {
    const { token } = await createTenantWithOwner();
    const otherStore = await prisma.store.create({
      data: {
        name: "Other",
        subdomain: `o-${crypto.randomUUID().slice(0, 8)}`,
        businessType: "OTHER",
        location: "Lagos",
        businessPhone: "+234 801 234 5678",
      },
    });
    const foreignGroup = await prisma.customerGroup.create({
      data: { storeId: otherStore.id, name: "X" },
    });

    const res = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade", groupId: foreignGroup.id });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("CUSTOMER_GROUP_NOT_FOUND");
  });
});
