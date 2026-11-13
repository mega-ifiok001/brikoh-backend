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

async function createStaffMember(storeId: string) {
  const email = `staff-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const staff = await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role: "STAFF", permissions: [] },
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
    DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "WalletEntry"; DELETE FROM "Payout"; DELETE FROM "StoreWallet"; DELETE FROM "BankAccount";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "NotificationDispatch";
    DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

describe("dashboard storefront settings (integration)", () => {
  it("returns the default set on first read", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .get("/api/dashboard/settings/storefront")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      template: "CLASSIC",
      tagline: null,
      heroTitle: null,
      heroSubtitle: null,
      accentColor: "#18181b",
      whatsappButtonEnabled: false,
      whatsappNumber: null,
      showPoweredByBadge: true,
      ga4MeasurementId: null,
      socialLinks: { instagram: null, facebook: null, tiktok: null },
    });
  });

  it("persists a valid ga4MeasurementId and rejects malformed ones", async () => {
    const { token } = await createTenantWithOwner();

    const set = await request(app)
      .put("/api/dashboard/settings/storefront")
      .set("Authorization", `Bearer ${token}`)
      .send({ ga4MeasurementId: "G-ABCDE12345" });
    expect(set.status).toBe(200);
    expect(set.body.ga4MeasurementId).toBe("G-ABCDE12345");

    const read = await request(app)
      .get("/api/dashboard/settings/storefront")
      .set("Authorization", `Bearer ${token}`);
    expect(read.body.ga4MeasurementId).toBe("G-ABCDE12345");

    const bad = await request(app)
      .put("/api/dashboard/settings/storefront")
      .set("Authorization", `Bearer ${token}`)
      .send({ ga4MeasurementId: "GT-123" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("clears ga4MeasurementId back to null explicitly", async () => {
    const { token } = await createTenantWithOwner();
    await request(app)
      .put("/api/dashboard/settings/storefront")
      .set("Authorization", `Bearer ${token}`)
      .send({ ga4MeasurementId: "G-ABCDE12345" });

    const cleared = await request(app)
      .put("/api/dashboard/settings/storefront")
      .set("Authorization", `Bearer ${token}`)
      .send({ ga4MeasurementId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.ga4MeasurementId).toBeNull();
  });

  it("persists a partial update and logs the activity entry", async () => {
    const { store, token } = await createTenantWithOwner();

    const res = await request(app)
      .put("/api/dashboard/settings/storefront")
      .set("Authorization", `Bearer ${token}`)
      .send({
        template: "MODERN",
        heroTitle: "Fresh goods, daily",
        accentColor: "#16a34a",
        whatsappButtonEnabled: true,
        whatsappNumber: "+2348012345678",
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      template: "MODERN",
      heroTitle: "Fresh goods, daily",
      accentColor: "#16a34a",
      whatsappButtonEnabled: true,
      whatsappNumber: "+2348012345678",
    });

    const activity = await prisma.storeActivityLog.findFirst({
      where: { storeId: store.id, action: "store.storefront.settings.updated" },
    });
    expect(activity).not.toBeNull();
  });

  it("rejects an accent color outside the swatch", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .put("/api/dashboard/settings/storefront")
      .set("Authorization", `Bearer ${token}`)
      .send({ accentColor: "#ff0000" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects staff with 403 ACCESS_DENIED", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id);

    const res = await request(app)
      .put("/api/dashboard/settings/storefront")
      .set("Authorization", `Bearer ${token}`)
      .send({ template: "BOLD" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });
});

describe("GET /api/dashboard/settings/business (integration)", () => {
  it("returns the persisted business profile", async () => {
    const { store, token } = await createTenantWithOwner();

    const res = await request(app)
      .get("/api/dashboard/settings/business")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      storeId: store.id,
      name: store.name,
      businessType: "OTHER",
      location: "Lagos, Nigeria",
      currency: "NGN",
      businessPhone: "+234 801 234 5678",
    });
  });

  it("rejects staff with 403", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id);

    const res = await request(app)
      .get("/api/dashboard/settings/business")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

describe("GET /api/public/storefront/:subdomain (integration)", () => {
  it("serves the narrow projection to an unauthenticated caller", async () => {
    const { store } = await createTenantWithOwner();
    await prisma.store.update({
      where: { id: store.id },
      data: {
        storefrontSettings: {
          template: "BOLD",
          heroTitle: "Hello",
          accentColor: "#db2777",
          whatsappButtonEnabled: true,
          whatsappNumber: "+2348012345678",
          socialLinks: { instagram: "https://ig.example.com/a" },
        } as never,
      },
    });

    const res = await request(app).get(`/api/public/storefront/${store.subdomain}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      storeName: store.name,
      subdomain: store.subdomain,
      template: "BOLD",
      heroTitle: "Hello",
      accentColor: "#db2777",
      whatsappButtonEnabled: true,
      whatsappNumber: "+2348012345678",
      socialLinks: { instagram: "https://ig.example.com/a" },
    });
    // The projection never leaks tenant data.
    expect(res.body.businessPhone).toBeUndefined();
    expect(res.body.location).toBeUndefined();
  });

  it("404s for an unknown subdomain", async () => {
    const res = await request(app).get("/api/public/storefront/no-such-store");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("STORE_NOT_FOUND");
  });

  describe("availablePaymentMethods flag", () => {
    it("is empty when neither a provider nor a bank account is configured", async () => {
      const { store } = await createTenantWithOwner();
      const res = await request(app).get(`/api/public/storefront/${store.subdomain}`);
      expect(res.status).toBe(200);
      expect(res.body.availablePaymentMethods).toEqual([]);
    });

    it("includes bank_transfer when a default merchant bank account exists", async () => {
      const { store } = await createTenantWithOwner();
      await prisma.bankAccount.create({
        data: {
          storeId: store.id,
          accountName: "Adebayo Idowu",
          bankName: "Access Bank",
          accountNumber: "0123456789",
          isDefault: true,
        },
      });
      const res = await request(app).get(`/api/public/storefront/${store.subdomain}`);
      expect(res.status).toBe(200);
      expect(res.body.availablePaymentMethods).toEqual(["bank_transfer"]);
    });

    it("includes paystack when a provider credential exists", async () => {
      const { store } = await createTenantWithOwner();
      await prisma.paymentCredential.create({
        data: {
          storeId: store.id,
          provider: "paystack",
          publicKey: "pk_test",
          secretKeyEncrypted: "enc",
        },
      });
      const res = await request(app).get(`/api/public/storefront/${store.subdomain}`);
      expect(res.status).toBe(200);
      expect(res.body.availablePaymentMethods).toEqual(["paystack"]);
    });

    it("lists both when configured", async () => {
      const { store } = await createTenantWithOwner();
      await prisma.bankAccount.create({
        data: {
          storeId: store.id,
          accountName: "Adebayo Idowu",
          bankName: "Access Bank",
          accountNumber: "0123456789",
          isDefault: true,
        },
      });
      await prisma.paymentCredential.create({
        data: {
          storeId: store.id,
          provider: "paystack",
          publicKey: "pk_test",
          secretKeyEncrypted: "enc",
        },
      });
      const res = await request(app).get(`/api/public/storefront/${store.subdomain}`);
      expect(res.status).toBe(200);
      expect(res.body.availablePaymentMethods).toEqual(["paystack", "bank_transfer"]);
    });
  });
});

describe("GET /api/public/storefront/:subdomain/products (integration)", () => {
  async function seedProduct(
    storeId: string,
    data: {
      name?: string;
      status?: "PUBLISHED" | "DRAFT";
      quantity?: number;
      lowStockThreshold?: number | null;
      categoryId?: string | null;
      price?: number;
    } = {},
  ) {
    return prisma.product.create({
      data: {
        storeId,
        name: data.name ?? `Product ${crypto.randomUUID().slice(0, 8)}`,
        price: data.price ?? 10,
        status: data.status ?? "PUBLISHED",
        quantity: data.quantity ?? 0,
        lowStockThreshold: data.lowStockThreshold ?? null,
        categoryId: data.categoryId ?? null,
      },
    });
  }

  async function seedVariant(
    storeId: string,
    productId: string,
    data: { name?: string; quantity?: number; sellingPrice?: number | null } = {},
  ) {
    return prisma.productVariant.create({
      data: {
        storeId,
        productId,
        name: data.name ?? `Variant ${crypto.randomUUID().slice(0, 8)}`,
        quantity: data.quantity ?? 0,
        sellingPrice: data.sellingPrice ?? null,
      },
    });
  }

  it("returns only PUBLISHED products (excludes DRAFT and soft-deleted)", async () => {
    const { store } = await createTenantWithOwner();
    await seedProduct(store.id, { name: "Published A" });
    await seedProduct(store.id, { name: "Draft B", status: "DRAFT" });
    const deleted = await seedProduct(store.id, { name: "Deleted C" });
    await prisma.product.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

    const res = await request(app).get(`/api/public/storefront/${store.subdomain}/products`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe("Published A");
    expect(res.body.message).toBeUndefined();
  });

  it("shows a published product at zero stock as OUT_OF_STOCK (not hidden)", async () => {
    const { store } = await createTenantWithOwner();
    await seedProduct(store.id, { name: "Empty", quantity: 0 });
    const res = await request(app).get(`/api/public/storefront/${store.subdomain}/products`);
    expect(res.status).toBe(200);
    expect(res.body.items[0].stockStatus).toBe("OUT_OF_STOCK");
  });

  it("derives stock status from the lowStockThreshold", async () => {
    const { store } = await createTenantWithOwner();
    await seedProduct(store.id, { name: "Low", quantity: 3, lowStockThreshold: 5 });
    await seedProduct(store.id, { name: "Ok", quantity: 10, lowStockThreshold: 5 });
    const res = await request(app).get(`/api/public/storefront/${store.subdomain}/products`);
    const byName = Object.fromEntries(
      res.body.items.map((p: { name: string; stockStatus: string }) => [p.name, p.stockStatus]),
    );
    expect(byName.Low).toBe("LOW_STOCK");
    expect(byName.Ok).toBe("IN_STOCK");
  });

  it("exposes per-variant stock status and an aggregated product status", async () => {
    const { store } = await createTenantWithOwner();
    const product = await seedProduct(store.id, { name: "Variant product", lowStockThreshold: 5 });
    await seedVariant(store.id, product.id, { name: "Small", quantity: 2, sellingPrice: 9.99 });
    await seedVariant(store.id, product.id, { name: "Large", quantity: 0 });

    const res = await request(app).get(`/api/public/storefront/${store.subdomain}/products`);
    const item = res.body.items[0];
    expect(item.stockStatus).toBe("LOW_STOCK");
    const small = item.variants.find((v: { name: string }) => v.name === "Small");
    const large = item.variants.find((v: { name: string }) => v.name === "Large");
    expect(small.stockStatus).toBe("LOW_STOCK");
    expect(small.sellingPrice).toBe("9.99");
    expect(large.stockStatus).toBe("OUT_OF_STOCK");
  });

  it("searches by name only, case-insensitively", async () => {
    const { store } = await createTenantWithOwner();
    await seedProduct(store.id, { name: "Cotton Shirt" });
    await seedProduct(store.id, { name: "Summer Tee" });
    const res = await request(app).get(
      `/api/public/storefront/${store.subdomain}/products?q=cotton`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe("Cotton Shirt");
  });

  it("filters by categoryId; a well-formed unknown category yields an empty 200 with a message", async () => {
    const { store } = await createTenantWithOwner();
    const category = await prisma.category.create({ data: { storeId: store.id, name: "Bags" } });
    await seedProduct(store.id, { name: "Clutch", categoryId: category.id });
    await seedProduct(store.id, { name: "No Category" });

    const matched = await request(app).get(
      `/api/public/storefront/${store.subdomain}/products?categoryId=${category.id}`,
    );
    expect(matched.status).toBe(200);
    expect(matched.body.items.map((p: { name: string }) => p.name)).toEqual(["Clutch"]);

    const empty = await request(app).get(
      `/api/public/storefront/${store.subdomain}/products?categoryId=${crypto.randomUUID()}`,
    );
    expect(empty.status).toBe(200);
    expect(empty.body.items).toHaveLength(0);
    expect(empty.body.message).toBe("There are no products in this category yet.");
  });

  it("returns 400 for a malformed cursor or categoryId", async () => {
    const { store } = await createTenantWithOwner();
    const badCursor = await request(app).get(
      `/api/public/storefront/${store.subdomain}/products?cursor=not-a-uuid`,
    );
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.code).toBe("VALIDATION_ERROR");

    const badCat = await request(app).get(
      `/api/public/storefront/${store.subdomain}/products?categoryId=123`,
    );
    expect(badCat.status).toBe(400);
    expect(badCat.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("paginates with limit and nextCursor", async () => {
    const { store } = await createTenantWithOwner();
    for (let i = 0; i < 3; i++) await seedProduct(store.id, { name: `P${i}` });

    const page1 = await request(app).get(
      `/api/public/storefront/${store.subdomain}/products?limit=2`,
    );
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.total).toBe(3);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await request(app).get(
      `/api/public/storefront/${store.subdomain}/products?limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();
  });

  it("isolates products to the resolved store", async () => {
    const a = await createTenantWithOwner();
    const b = await createTenantWithOwner();
    await seedProduct(a.store.id, { name: "Only A" });
    await seedProduct(b.store.id, { name: "Only B" });

    const res = await request(app).get(`/api/public/storefront/${a.store.subdomain}/products`);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].name).toBe("Only A");
  });

  it("returns a human-readable message when the store has no published products", async () => {
    const { store } = await createTenantWithOwner();
    const res = await request(app).get(`/api/public/storefront/${store.subdomain}/products`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.message).toBe("This store hasn't published any products yet.");
  });
});

describe("GET /api/public/storefront/:subdomain/products/:productId (integration)", () => {
  it("returns a published product with its variants", async () => {
    const { store } = await createTenantWithOwner();
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Detail Product", price: 15, status: "PUBLISHED" },
    });
    await prisma.productVariant.create({
      data: { storeId: store.id, productId: product.id, name: "One Size", quantity: 4 },
    });
    const res = await request(app).get(
      `/api/public/storefront/${store.subdomain}/products/${product.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(product.id);
    expect(res.body.price).toBe("15.00");
    expect(res.body.variants).toHaveLength(1);
  });

  it("404s for a DRAFT or cross-store product with a human-readable message", async () => {
    const a = await createTenantWithOwner();
    const b = await createTenantWithOwner();
    const draft = await prisma.product.create({
      data: { storeId: a.store.id, name: "Hidden", price: 1, status: "DRAFT" },
    });
    const others = await prisma.product.create({
      data: { storeId: b.store.id, name: "Belongs to B", price: 1, status: "PUBLISHED" },
    });

    const draftRes = await request(app).get(
      `/api/public/storefront/${a.store.subdomain}/products/${draft.id}`,
    );
    expect(draftRes.status).toBe(404);
    expect(draftRes.body.error.code).toBe("PRODUCT_NOT_FOUND");
    expect(draftRes.body.error.message).toMatch(/couldn't find that product/i);

    const otherRes = await request(app).get(
      `/api/public/storefront/${a.store.subdomain}/products/${others.id}`,
    );
    expect(otherRes.status).toBe(404);
    expect(otherRes.body.error.code).toBe("PRODUCT_NOT_FOUND");
  });
});

describe("GET /api/public/storefront/:subdomain/categories (integration)", () => {
  it("returns only the resolved store's categories", async () => {
    const a = await createTenantWithOwner();
    const b = await createTenantWithOwner();
    await prisma.category.create({ data: { storeId: a.store.id, name: "A-Cat" } });
    await prisma.category.create({ data: { storeId: b.store.id, name: "B-Cat" } });

    const res = await request(app).get(`/api/public/storefront/${a.store.subdomain}/categories`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toEqual({ id: expect.any(String), name: "A-Cat" });
  });
});
