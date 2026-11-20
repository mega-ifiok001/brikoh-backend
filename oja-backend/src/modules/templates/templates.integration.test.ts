import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { takeTestOtp } from "../auth/testOtpOutbox.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

const VALID = {
  firstName: "Ade",
  lastName: "Okafor",
  phone: "+234 801 234 5678",
  email: "owner@example.com",
  password: "password-123",
  confirmPassword: "password-123",
};

const ONBOARD_PROFILE = {
  name: "Ades Store",
  businessType: "RETAIL",
  location: "Lagos, Nigeria",
  currency: "NGN",
  businessPhone: "+234 801 234 5678",
};

async function createAccount() {
  const email = `account-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  return { account, email };
}

async function createTenantWithOwner() {
  const { account } = await createAccount();
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
  return { account, store, token };
}

async function createStaff(storeId: string) {
  const { account } = await createAccount();
  await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role: "STAFF", permissions: [] },
  });
  return signAccessToken({ sub: account.id, storeId, role: "STAFF" });
}

/** Attaches an ACTIVE subscription to the store (tier default templateCap). */
async function attachSubscription(storeId: string, overrides: Record<string, unknown> = {}) {
  const subscription = await prisma.subscription.create({
    data: {
      storeId,
      tier: "STARTER",
      status: "ACTIVE",
      currentPeriodStart: new Date(Date.now() - 2 * 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      templateCap: null,
      ...overrides,
    },
  });
  await prisma.store.update({
    where: { id: storeId },
    data: { subscriptionId: subscription.id },
  });
  return subscription;
}

/** The seeded catalog rows (created by the store-templates migration). */
async function seededTemplates() {
  return prisma.storeTemplate.findMany({ orderBy: { sortOrder: "asc" } });
}

beforeEach(async () => {
  // StoreTemplate is platform seed data — never wiped. Stores reference
  // it via templateId (Restrict), so stores go first in the delete order.
  await prisma.$executeRaw`
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" DISABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" DISABLE TRIGGER purchase_order_payment_append_only;
    DELETE FROM "RefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
    DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

describe("GET /api/dashboard/templates (integration)", () => {
  it("returns the pre-subscription STARTER set for a tenant-less account (pre-onboarding)", async () => {
    const { account } = await createAccount();
    const token = signAccessToken({ sub: account.id, role: "" });

    const res = await request(app)
      .get("/api/dashboard/templates")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("STARTER");
    expect(res.body.visibleCount).toBe(3);
    expect(res.body.templates).toHaveLength(3);
    expect(res.body.selectedTemplateId).toBeNull();
  });

  it("shows 3 templates on STARTER, 5 on PRO, and all on ENTERPRISE (superset)", async () => {
    const templates = await seededTemplates();
    const cases = [
      { tier: "STARTER", expect: 3 },
      { tier: "PRO", expect: 5 },
      { tier: "ENTERPRISE", expect: templates.length },
    ] as const;
    for (const { tier, expect: count } of cases) {
      const { store, token } = await createTenantWithOwner();
      await attachSubscription(store.id, { tier });

      const res = await request(app)
        .get("/api/dashboard/templates")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.tier).toBe(tier);
      expect(res.body.templates).toHaveLength(count);
      expect(res.body.templates.map((t: { id: string }) => t.id)).toEqual(
        templates.slice(0, count).map((t) => t.id),
      );
    }
  });

  it("degrades an inactive subscription to the STARTER set", async () => {
    const { store, token } = await createTenantWithOwner();
    await attachSubscription(store.id, { tier: "PRO", status: "PAST_DUE" });

    const res = await request(app)
      .get("/api/dashboard/templates")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("STARTER");
    expect(res.body.templates).toHaveLength(3);
  });

  it("reports the store's current selection once a template is set", async () => {
    const { store, token } = await createTenantWithOwner();
    const templates = await seededTemplates();
    await prisma.store.update({
      where: { id: store.id },
      data: { templateId: templates[1]!.id },
    });

    const res = await request(app)
      .get("/api/dashboard/templates")
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.selectedTemplateId).toBe(templates[1]!.id);
  });

  it("rejects an unauthenticated request (401 NEED_LOGIN)", async () => {
    const res = await request(app).get("/api/dashboard/templates");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("NEED_LOGIN");
  });
});

describe("PUT /api/dashboard/templates (integration)", () => {
  it("sets a template from the store's visible set (owner)", async () => {
    const { store, token } = await createTenantWithOwner();
    const templates = await seededTemplates();

    const res = await request(app)
      .put("/api/dashboard/templates")
      .set("Authorization", `Bearer ${token}`)
      .send({ templateId: templates[2]!.id });

    expect(res.status).toBe(200);
    expect(res.body.template.id).toBe(templates[2]!.id);
    const row = await prisma.store.findUnique({ where: { id: store.id } });
    expect(row?.templateId).toBe(templates[2]!.id);
  });

  it("rejects a template beyond the tier's visible set (400 TEMPLATE_NOT_AVAILABLE)", async () => {
    const { store, token } = await createTenantWithOwner();
    const templates = await seededTemplates();
    // No subscription attached → STARTER set (first 3); template #5 is out.
    const outOfTier = templates[4]!;

    const res = await request(app)
      .put("/api/dashboard/templates")
      .set("Authorization", `Bearer ${token}`)
      .send({ templateId: outOfTier.id });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TEMPLATE_NOT_AVAILABLE");
    const row = await prisma.store.findUnique({ where: { id: store.id } });
    expect(row?.templateId).toBeNull();
  });

  it("rejects a malformed templateId (400 VALIDATION_ERROR)", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .put("/api/dashboard/templates")
      .set("Authorization", `Bearer ${token}`)
      .send({ templateId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects staff with 403 ACCESS_DENIED (owner-only)", async () => {
    const { store } = await createTenantWithOwner();
    const staffToken = await createStaff(store.id);
    const templates = await seededTemplates();

    const res = await request(app)
      .put("/api/dashboard/templates")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ templateId: templates[0]!.id });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });

  it("rejects an unauthenticated request (401 NEED_LOGIN)", async () => {
    const res = await request(app)
      .put("/api/dashboard/templates")
      .send({ templateId: "019FC8C4-5A01-7001-8001-000000000001" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("NEED_LOGIN");
  });
});

describe("PUT /api/dashboard/templates/customization (integration)", () => {
  it("saves a full customization and echoes the normalized settings (owner)", async () => {
    const { store, token } = await createTenantWithOwner();

    const res = await request(app)
      .put("/api/dashboard/templates/customization")
      .set("Authorization", `Bearer ${token}`)
      .send({
        accentColor: "#B45309",
        logoUrl: "https://cdn.example.com/logo.png",
        heroText: "Fresh from Lagos",
        heroSubtext: "Handpicked goods, delivered daily",
        announcementBar: { enabled: true, text: "Free delivery on orders over ₦50,000" },
      });

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      accentColor: "#B45309",
      logoUrl: "https://cdn.example.com/logo.png",
      heroText: "Fresh from Lagos",
      heroSubtext: "Handpicked goods, delivered daily",
      announcementBar: { enabled: true, text: "Free delivery on orders over ₦50,000" },
    });
    const row = await prisma.store.findUnique({ where: { id: store.id } });
    expect(row?.templateSettings).toEqual({
      accentColor: "#B45309",
      logoUrl: "https://cdn.example.com/logo.png",
      heroText: "Fresh from Lagos",
      heroSubtext: "Handpicked goods, delivered daily",
      announcementBar: { enabled: true, text: "Free delivery on orders over ₦50,000" },
    });
  });

  it("applies replace semantics: an omitted key clears the previous value", async () => {
    const { store, token } = await createTenantWithOwner();
    await prisma.store.update({
      where: { id: store.id },
      data: { templateSettings: { accentColor: "#B45309", heroText: "Old hero" } },
    });

    const res = await request(app)
      .put("/api/dashboard/templates/customization")
      .set("Authorization", `Bearer ${token}`)
      .send({ accentColor: "#123456" });

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      accentColor: "#123456",
      logoUrl: null,
      heroText: null,
      heroSubtext: null,
      announcementBar: null,
    });
    const row = await prisma.store.findUnique({ where: { id: store.id } });
    expect(row?.templateSettings).toEqual({ accentColor: "#123456" });
  });

  it("clears everything with {} (back to template defaults)", async () => {
    const { store, token } = await createTenantWithOwner();
    await prisma.store.update({
      where: { id: store.id },
      data: { templateSettings: { accentColor: "#B45309", heroText: "Old hero" } },
    });

    const res = await request(app)
      .put("/api/dashboard/templates/customization")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.settings).toBeNull();
    const row = await prisma.store.findUnique({ where: { id: store.id } });
    expect(row?.templateSettings).toBeNull();
  });

  it("GET /templates surfaces the saved settings", async () => {
    const { store, token } = await createTenantWithOwner();
    await prisma.store.update({
      where: { id: store.id },
      data: { templateSettings: { heroText: "Fresh from Lagos" } },
    });

    const res = await request(app)
      .get("/api/dashboard/templates")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      accentColor: null,
      logoUrl: null,
      heroText: "Fresh from Lagos",
      heroSubtext: null,
      announcementBar: null,
    });
  });

  it("rejects a malformed body before any write (400 VALIDATION_ERROR)", async () => {
    const { store, token } = await createTenantWithOwner();

    const res = await request(app)
      .put("/api/dashboard/templates/customization")
      .set("Authorization", `Bearer ${token}`)
      .send({ accentColor: "not-a-hex", heroText: "x".repeat(200) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const row = await prisma.store.findUnique({ where: { id: store.id } });
    expect(row?.templateSettings).toBeNull();
  });

  it("rejects unknown keys (400 VALIDATION_ERROR)", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .put("/api/dashboard/templates/customization")
      .set("Authorization", `Bearer ${token}`)
      .send({ accentColour: "#B45309" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects staff with 403 ACCESS_DENIED (owner-only)", async () => {
    const { store } = await createTenantWithOwner();
    const staffToken = await createStaff(store.id);

    const res = await request(app)
      .put("/api/dashboard/templates/customization")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ heroText: "Fresh from Lagos" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });

  it("rejects an unauthenticated request (401 NEED_LOGIN)", async () => {
    const res = await request(app)
      .put("/api/dashboard/templates/customization")
      .send({ heroText: "Fresh from Lagos" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("NEED_LOGIN");
  });
});

describe("POST /api/dashboard/onboarding with templateId (integration)", () => {
  async function registerAndVerify() {
    const res = await request(app).post("/api/public/auth/register").send(VALID);
    expect(res.status).toBe(201);
    const message = takeTestOtp(res.body.user.email, "EMAIL_VERIFICATION");
    expect(message).toBeDefined();
    const verify = await request(app)
      .post("/api/public/auth/verify")
      .send({ email: res.body.user.email, code: message!.code });
    expect(verify.status).toBe(200);
    return res;
  }

  async function onboard(token: string, body: Record<string, unknown>) {
    return request(app)
      .post("/api/dashboard/onboarding")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  it("defaults the store to the first visible template when templateId is omitted", async () => {
    const reg = await registerAndVerify();
    const templates = await seededTemplates();

    const res = await onboard(reg.body.accessToken, ONBOARD_PROFILE);

    expect(res.status).toBe(201);
    const store = await prisma.store.findUnique({
      where: { id: res.body.user.storeId },
    });
    expect(store?.templateId).toBe(templates[0]!.id);
  });

  it("accepts a template inside the pre-subscription STARTER set", async () => {
    const reg = await registerAndVerify();
    const templates = await seededTemplates();

    const res = await onboard(reg.body.accessToken, {
      ...ONBOARD_PROFILE,
      templateId: templates[2]!.id,
    });

    expect(res.status).toBe(201);
    const store = await prisma.store.findUnique({
      where: { id: res.body.user.storeId },
    });
    expect(store?.templateId).toBe(templates[2]!.id);
  });

  it("rejects a template beyond the STARTER set and creates no store (400 TEMPLATE_NOT_AVAILABLE)", async () => {
    const reg = await registerAndVerify();
    const templates = await seededTemplates();

    const res = await onboard(reg.body.accessToken, {
      ...ONBOARD_PROFILE,
      templateId: templates[5]!.id,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TEMPLATE_NOT_AVAILABLE");
    const store = await prisma.store.findFirst({ where: { name: "Ades Store" } });
    expect(store).toBeNull();
  });

  it("rejects a malformed templateId (400 VALIDATION_ERROR)", async () => {
    const reg = await registerAndVerify();

    const res = await onboard(reg.body.accessToken, {
      ...ONBOARD_PROFILE,
      templateId: "not-a-uuid",
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
