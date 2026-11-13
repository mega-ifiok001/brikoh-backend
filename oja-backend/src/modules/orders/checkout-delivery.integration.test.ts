import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

const TENANT_WIPE = `
  ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
  ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
  ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_ledger_append_only;
  DELETE FROM "DeliveryOption";
  DELETE FROM "WalletEntry"; DELETE FROM "Payout"; DELETE FROM "StoreWallet"; DELETE FROM "BankAccount";
  DELETE FROM "NotificationDispatch"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem"; DELETE FROM "Order";
  DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
  DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
  DELETE FROM "BranchStock"; DELETE FROM "Branch"; DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
  DELETE FROM "StoreActivityLog"; DELETE FROM "PaymentCredential"; DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
  ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
  ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
  ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
`;

async function createTenantWithOwner() {
  const account = await prisma.account.create({
    data: {
      email: `owner-${crypto.randomUUID()}@example.com`,
      passwordHash: bcrypt.hashSync("password-123", 4),
    },
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

async function createStaffMember(storeId: string) {
  const account = await prisma.account.create({
    data: {
      email: `staff-${crypto.randomUUID()}@example.com`,
      passwordHash: bcrypt.hashSync("password-123", 4),
    },
  });
  const staff = await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role: "STAFF", permissions: [] },
  });
  const token = signAccessToken({ sub: account.id, storeId, role: "STAFF" });
  return { staff, token };
}

async function createProduct(storeId: string) {
  const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { defaultBranchId: true },
  });
  const product = await prisma.product.create({
    data: {
      storeId,
      name: `Product ${crypto.randomUUID().slice(0, 8)}`,
      price: 10,
      quantity: 10,
      status: "PUBLISHED",
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

async function createBankAccount(storeId: string) {
  return prisma.bankAccount.create({
    data: {
      storeId,
      accountName: "Adebayo Idowu",
      bankName: "Access Bank",
      accountNumber: "0123456789",
      isDefault: true,
    },
  });
}

const ADDRESS = {
  deliveryAddress: "12 Admiralty Way, Lekki",
  deliveryCity: "Lagos",
  deliveryState: "Lagos",
  deliveryPhone: "08012345678",
};

function checkoutBody(productId: string, delivery: Record<string, string> = {}) {
  return {
    customer: { name: "Ade Buyer", email: "buyer@example.com", phone: "08012345678" },
    items: [{ productId, quantity: 2 }],
    paymentMethod: "bank_transfer" as const,
    ...delivery,
  };
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(TENANT_WIPE);
});

describe("delivery options (integration)", () => {
  it("creates, lists, updates, and deletes flat-fee options (owner-only)", async () => {
    const { store, token } = await createTenantWithOwner();

    const created = await request(app)
      .post("/api/dashboard/settings/delivery-options")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Delivery Rider", kind: "DELIVERY", baseFee: "2000", description: "Same-day" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Delivery Rider", baseFee: "2000.00" });
    expect(created.body).not.toHaveProperty("zones");
    const optionId = created.body.id as string;

    const list = await request(app)
      .get("/api/dashboard/settings/delivery-options")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.deliveryOptions).toHaveLength(1);

    const updated = await request(app)
      .put(`/api/dashboard/settings/delivery-options/${optionId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ baseFee: "2500", isActive: false });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ baseFee: "2500.00", isActive: false });

    const deleted = await request(app)
      .delete(`/api/dashboard/settings/delivery-options/${optionId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(deleted.status).toBe(204);
    expect(await prisma.deliveryOption.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("rejects a duplicate name (409)", async () => {
    const { token } = await createTenantWithOwner();
    const body = { name: "Pick up at store", kind: "PICKUP" };
    await request(app)
      .post("/api/dashboard/settings/delivery-options")
      .set("Authorization", `Bearer ${token}`)
      .send(body)
      .expect(201);

    const dup = await request(app)
      .post("/api/dashboard/settings/delivery-options")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(dup.status).toBe(409);
  });

  it("rejects staff (owner-only)", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id);

    const res = await request(app)
      .get("/api/dashboard/settings/delivery-options")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("404s another store's option", async () => {
    const a = await createTenantWithOwner();
    const b = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/settings/delivery-options")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ name: "Pickup", kind: "PICKUP" })
      .expect(201);

    const res = await request(app)
      .put(`/api/dashboard/settings/delivery-options/${created.body.id}`)
      .set("Authorization", `Bearer ${b.token}`)
      .send({ baseFee: "100" });
    expect(res.status).toBe(404);
  });
});

describe("storefront checkout with delivery (integration)", () => {
  async function deliveryOption(storeId: string, baseFee = 2000) {
    return prisma.deliveryOption.create({
      data: { storeId, name: "Delivery Rider", kind: "DELIVERY", baseFee, isActive: true },
    });
  }

  it("exposes active options (no zones) on the public storefront", async () => {
    const { store } = await createTenantWithOwner();
    await deliveryOption(store.id);
    await prisma.deliveryOption.create({
      data: { storeId: store.id, name: "Hidden", kind: "PICKUP", isActive: false },
    });

    const res = await request(app).get(`/api/public/storefront/${store.subdomain}`);
    expect(res.status).toBe(200);
    expect(res.body.deliveryOptions).toHaveLength(1);
    expect(res.body.deliveryOptions[0]).toMatchObject({
      name: "Delivery Rider",
      kind: "DELIVERY",
      baseFee: "2000.00",
    });
    expect(res.body.deliveryOptions[0]).not.toHaveProperty("zones");
  });

  it("charges the option's baseFee and freezes the address snapshot", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    await createBankAccount(store.id);
    const option = await deliveryOption(store.id, 2000);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody(product.id, { deliveryOptionId: option.id, ...ADDRESS }));

    expect(res.status).toBe(200);
    // 2 x 10.00 + 2000 delivery = 2020.00
    expect(res.body.order.total).toBe("2020");

    const row = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id } });
    expect(row.deliveryFee.toFixed(2)).toBe("2000.00");
    expect(row.deliveryOptionName).toBe("Delivery Rider");
    expect(row.deliveryKind).toBe("DELIVERY");
    expect(row.deliveryAddress).toBe(ADDRESS.deliveryAddress);
    expect(row.deliveryCity).toBe(ADDRESS.deliveryCity);
    expect(row.deliveryState).toBe(ADDRESS.deliveryState);
    expect(row.deliveryPhone).toBe(ADDRESS.deliveryPhone);
  });

  it("requires a selection when the store has active options", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    await createBankAccount(store.id);
    await deliveryOption(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody(product.id));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DELIVERY_OPTION_REQUIRED");
  });

  it("requires address, city, state, and phone for a DELIVERY option", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    await createBankAccount(store.id);
    const option = await deliveryOption(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody(product.id, { deliveryOptionId: option.id, deliveryAddress: "x" }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("DELIVERY_DETAILS_REQUIRED");
    expect(res.body.error.message).toMatch(/city/i);
  });

  it("allows a PICKUP option with no address fields", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    await createBankAccount(store.id);
    const pickup = await prisma.deliveryOption.create({
      data: { storeId: store.id, name: "Pick up at store", kind: "PICKUP", baseFee: 0, isActive: true },
    });

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody(product.id, { deliveryOptionId: pickup.id }));

    expect(res.status).toBe(200);
    expect(res.body.order.total).toBe("20");
    const row = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id } });
    expect(row.deliveryKind).toBe("PICKUP");
    expect(row.deliveryAddress).toBeNull();
  });

  it("404s an unknown option", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    await createBankAccount(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(
        checkoutBody(product.id, {
          deliveryOptionId: "11111111-1111-4111-8111-111111111111",
          ...ADDRESS,
        }),
      );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("DELIVERY_OPTION_NOT_FOUND");
  });

  it("keeps the frozen snapshot after the option is deleted", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    await createBankAccount(store.id);
    const option = await deliveryOption(store.id, 2000);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody(product.id, { deliveryOptionId: option.id, ...ADDRESS }));
    expect(res.status).toBe(200);
    const orderId = res.body.order.id as string;

    await prisma.deliveryOption.delete({ where: { id: option.id } });

    const row = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(row.deliveryOptionId).toBeNull();
    expect(row.deliveryOptionName).toBe("Delivery Rider");
    expect(row.deliveryFee.toFixed(2)).toBe("2000.00");

    const pub = await request(app).get(`/api/public/orders/${orderId}`);
    expect(pub.status).toBe(200);
    expect(pub.body.delivery).toMatchObject({
      kind: "DELIVERY",
      optionName: "Delivery Rider",
      address: ADDRESS.deliveryAddress,
      city: ADDRESS.deliveryCity,
      fee: "2000.00",
    });
  });

  it("allows checkout with no delivery when the store has no options", async () => {
    const { store } = await createTenantWithOwner();
    const product = await createProduct(store.id);
    await createBankAccount(store.id);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send(checkoutBody(product.id));

    expect(res.status).toBe(200);
    expect(res.body.order.total).toBe("20");
    const row = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id } });
    expect(row.deliveryOptionName).toBeNull();
    expect(row.deliveryFee.toFixed(2)).toBe("0.00");
  });
});
