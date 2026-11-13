import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";
import { type $Enums } from "../../../generated/prisma/client.js";
import { generateTotpSecret, generateTotpToken } from "./totp.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

const RANGE_START = "2026-08-01T00:00:00.000Z";
const RANGE_END = "2026-08-31T00:00:00.000Z";

const SUPER_KEYS = ["stores:view", "billing:edit", "operations:run", "audit:view"];

beforeEach(async () => {
  // DELETE instead of TRUNCATE: TRUNCATE fsyncs every table file
  // (DataFileImmediateSync), which is very slow on rotational disks.
  // Child tables first to satisfy foreign keys. The append-only triggers
  // block DELETE, so they are disabled for the duration of the wipe.
  await prisma.$executeRaw`
    ALTER TABLE "AdminAuditLog" DISABLE TRIGGER admin_audit_append_only;
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" DISABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" DISABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_ledger_append_only;
    DELETE FROM "RefreshToken"; DELETE FROM "AdminRefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
    DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "WalletEntry"; DELETE FROM "Payout"; DELETE FROM "StoreWallet"; DELETE FROM "BankAccount";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "PaymentCredential";
    DELETE FROM "TicketMessage"; DELETE FROM "SupportTicket";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "Owner"; DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
    DELETE FROM "AdminAuditLog"; DELETE FROM "AdminUser"; DELETE FROM "RolePermission";
    DELETE FROM "Permission"; DELETE FROM "Role";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "AdminAuditLog" ENABLE TRIGGER admin_audit_append_only;
  `;
});

async function uniqueRole(name: string, keys: string[]) {
  // The test database is wiped in beforeEach, so exact role names are
  // unique per test — SUPER_ADMIN/SUPPORT_ADMIN naming is meaningful.
  const role = await prisma.role.create({ data: { name } });
  for (const key of keys) {
    const permission = await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  }
  return role;
}

async function createAdmin(options: { roleName: string; keys: string[]; email?: string }) {
  const role = await uniqueRole(options.roleName, options.keys);
  const password = "password-123";
  const secret = generateTotpSecret();
  const admin = await prisma.adminUser.create({
    data: {
      email: options.email ?? `admin-${crypto.randomUUID()}@example.com`,
      passwordHash: bcrypt.hashSync(password, 4),
      twoFactorSecret: secret,
      roleId: role.id,
    },
  });
  return { admin, role, secret, password };
}

async function login(
  email: string,
  password: string,
  totpToken: string,
  headers: Record<string, string> = {},
) {
  return request(app).post("/api/admin/auth/login").set(headers).send({
    email,
    password,
    totpToken,
  });
}

async function createTenant(options: { createdAt?: Date; name?: string } = {}) {
  const email = `owner-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const store = await prisma.store.create({
    data: {
      name: options.name ?? `Store ${crypto.randomUUID().slice(0, 8)}`,
      subdomain: `s-${crypto.randomUUID().slice(0, 8)}`,
      businessType: "OTHER",
      location: "Lagos, Nigeria",
      businessPhone: "+234 801 234 5678",
      createdAt: options.createdAt,
    },
  });
  const mainBranch = await prisma.branch.create({
    data: { storeId: store.id, name: "Main Branch", address: "Lagos, Nigeria" },
  });
  await prisma.store.update({ where: { id: store.id }, data: { defaultBranchId: mainBranch.id } });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  return { account, store, mainBranch };
}

async function createSupportTicket(
  storeId: string,
  options: {
    subject?: string;
    priority?: $Enums.TicketPriority;
    status?: $Enums.TicketStatus;
    assignedAdminId?: string | null;
    createdAt?: Date;
  } = {},
) {
  return prisma.supportTicket.create({
    data: {
      storeId,
      subject: options.subject ?? `Ticket ${crypto.randomUUID().slice(0, 8)}`,
      priority: options.priority,
      status: options.status,
      assignedAdminId: options.assignedAdminId,
      createdAt: options.createdAt,
    },
  });
}

async function createTicketMessage(
  ticketId: string,
  options: {
    body: string;
    authorType: $Enums.TicketAuthorType;
    authorAccountId?: string;
    authorAdminId?: string;
    createdAt?: Date;
  },
) {
  return prisma.ticketMessage.create({
    data: {
      ticketId,
      body: options.body,
      authorType: options.authorType,
      authorAccountId: options.authorAccountId,
      authorAdminId: options.authorAdminId,
      createdAt: options.createdAt,
    },
  });
}

// Defaults mirror prisma/seed.ts; pinned here so assertions about the
// pricing table are deterministic regardless of what earlier tests mutated.
async function seedDefaultPricing() {
  await prisma.$transaction([
    prisma.subscriptionPlanSetting.upsert({
      where: { plan: "STARTER" },
      update: { monthlyPrice: null },
      create: { plan: "STARTER", monthlyPrice: null },
    }),
    prisma.subscriptionPlanSetting.upsert({
      where: { plan: "PRO" },
      update: { monthlyPrice: 4900 },
      create: { plan: "PRO", monthlyPrice: 4900 },
    }),
    prisma.subscriptionPlanSetting.upsert({
      where: { plan: "ENTERPRISE" },
      update: { monthlyPrice: 19000 },
      create: { plan: "ENTERPRISE", monthlyPrice: 19000 },
    }),
  ]);
}

async function attachSubscription(
  storeId: string,
  options: {
    tier: "STARTER" | "PRO" | "ENTERPRISE";
    status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELLED";
    createdAt?: Date;
    updatedAt?: Date;
    currentPeriodStart?: Date;
    productCap?: number | null;
  },
) {
  const now = Date.now();
  const subscription = await prisma.subscription.create({
    data: {
      storeId,
      tier: options.tier,
      status: options.status,
      currentPeriodStart: options.currentPeriodStart ?? new Date(now - 30 * 86_400_000),
      currentPeriodEnd: new Date(now + 30 * 86_400_000),
      createdAt: options.createdAt ?? new Date(now - 30 * 86_400_000),
      updatedAt: options.updatedAt ?? new Date(now),
      staffCap: null,
      locationCap: null,
      productCap: options.productCap ?? null,
      orderCap: null,
    },
  });
  await prisma.store.update({ where: { id: storeId }, data: { subscriptionId: subscription.id } });
  return subscription;
}

async function createProductRow(storeId: string, name: string, quantity = 100, createdAt?: Date) {
  const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { defaultBranchId: true },
  });
  const product = await prisma.product.create({
    data: { storeId, name, price: 10, quantity, createdAt },
  });
  await prisma.branchStock.create({
    data: { storeId, branchId: defaultBranchId!, productId: product.id, variantId: null, quantity },
  });
  return product;
}

async function createCustomer(storeId: string) {
  return prisma.customer.create({
    data: { storeId, name: "Test Customer", email: `cust-${crypto.randomUUID()}@example.com` },
  });
}

/** Store with a controllable owner email + currency (for the view endpoints). */
async function createStoreWithOwner(options: { name?: string; email?: string; currency?: string }) {
  const email = options.email ?? `owner-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const store = await prisma.store.create({
    data: {
      name: options.name ?? `Store ${crypto.randomUUID().slice(0, 8)}`,
      subdomain: `s-${crypto.randomUUID().slice(0, 8)}`,
      businessType: "OTHER",
      location: "Lagos, Nigeria",
      businessPhone: "+234 801 234 5678",
      currency: (options.currency ?? "NGN") as $Enums.Currency,
    },
  });
  const mainBranch = await prisma.branch.create({
    data: { storeId: store.id, name: "Main Branch", address: "Lagos, Nigeria" },
  });
  await prisma.store.update({
    where: { id: store.id },
    data: { defaultBranchId: mainBranch.id },
  });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  return { account, store, mainBranch };
}

async function createOrderRow(
  storeId: string,
  options: {
    createdAt: Date;
    status: $Enums.OrderStatus;
    total?: number;
    paymentReference?: string;
  },
) {
  const customer = await createCustomer(storeId);
  const product = await createProductRow(storeId, `Product ${crypto.randomUUID().slice(0, 6)}`);
  const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { defaultBranchId: true },
  });
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        storeId,
        customerId: customer.id,
        branchId: defaultBranchId!,
        orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
        status: options.status,
        total: options.total ?? 20,
        createdAt: options.createdAt,
        paymentProvider: "PAYSTACK",
        paymentReference: options.paymentReference,
      },
    });
    await tx.orderLineItem.create({
      data: {
        storeId,
        orderId: order.id,
        productId: product.id,
        quantity: 2,
        unitPriceAtPurchase: 10,
      },
    });
    return { order, product };
  });
}

describe("admin auth (separate token type, 2FA mandatory)", () => {
  let fixture: { admin: { id: string; email: string }; secret: string; password: string };

  beforeEach(async () => {
    fixture = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
  });

  it("logs in with password + TOTP and gets an admin session (happy path)", async () => {
    const res = await login(
      fixture.admin.email,
      fixture.password,
      generateTotpToken(fixture.secret),
    );
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.admin).toMatchObject({ email: fixture.admin.email, roleName: "SUPER_ADMIN" });
  });

  it("rejects a wrong password with the same 401 code (sad path)", async () => {
    const res = await login(
      fixture.admin.email,
      "wrong-password",
      generateTotpToken(fixture.secret),
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects an unknown email (sad path)", async () => {
    const res = await login("nobody@example.com", "password-123", "123456");
    expect(res.status).toBe(401);
  });

  it("rejects an invalid TOTP even with valid credentials (sad path — 2FA mandatory)", async () => {
    const res = await login(fixture.admin.email, fixture.password, "000000");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("2FA_INVALID");
  });

  it("rejects a malformed login body (edge case)", async () => {
    const res = await login(fixture.admin.email, fixture.password, "12345");
    expect(res.status).toBe(400);
  });

  it("serves /me only to admin tokens, never merchant tokens (trust boundary)", async () => {
    const session = await login(
      fixture.admin.email,
      fixture.password,
      generateTotpToken(fixture.secret),
    );
    const me = await request(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${session.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.permissions).toEqual(expect.arrayContaining(SUPER_KEYS));

    const { account } = await createTenant();
    const merchantToken = signAccessToken({ sub: account.id, role: "OWNER" });
    const rejected = await request(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${merchantToken}`);
    expect(rejected.status).toBe(401);
  });

  it("rotates its own 2FA secret; the old secret stops working (happy + edge)", async () => {
    const session = await login(
      fixture.admin.email,
      fixture.password,
      generateTotpToken(fixture.secret),
    );
    const rotated = await request(app)
      .post("/api/admin/auth/2fa/rotate")
      .set("Authorization", `Bearer ${session.body.accessToken}`)
      .send({});
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).toMatch(/^[A-Z2-7]+={0,3}$/);

    const oldCode = generateTotpToken(fixture.secret);
    const withOld = await login(fixture.admin.email, fixture.password, oldCode);
    expect(withOld.status).toBe(401);
    const withNew = await login(
      fixture.admin.email,
      fixture.password,
      generateTotpToken(rotated.body.secret),
    );
    expect(withNew.status).toBe(200);
  });
});

describe("admin 2FA break-glass reset", () => {
  it("SUPER_ADMIN resets another admin's 2FA; old code stops working, audit logged, nothing destroyed", async () => {
    const superAdmin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const target = await createAdmin({ roleName: "TARGET", keys: [] });

    const session = await login(
      superAdmin.admin.email,
      superAdmin.password,
      generateTotpToken(superAdmin.secret),
    );
    expect(session.status).toBe(200);

    const reset = await request(app)
      .post("/api/admin/auth/2fa/reset")
      .set("Authorization", `Bearer ${session.body.accessToken}`)
      .send({ adminUserId: target.admin.id });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ email: target.admin.email });
    expect(reset.body.secret).toMatch(/^[A-Z2-7]+={0,3}$/);
    expect(reset.body.otpauthUrl).toContain("otpauth://");

    // The old secret no longer authenticates; the new one does.
    const withOld = await login(
      target.admin.email,
      target.password,
      generateTotpToken(target.secret),
    );
    expect(withOld.status).toBe(401);
    const withNew = await login(
      target.admin.email,
      target.password,
      generateTotpToken(reset.body.secret),
    );
    expect(withNew.status).toBe(200);

    // Exactly one reset audit row; the target admin is otherwise untouched.
    const auditRows = await prisma.adminAuditLog.findMany({ where: { action: "admin.2fa.reset" } });
    expect(auditRows).toHaveLength(1);
    const row = auditRows[0]!;
    expect(row.detail).toMatchObject({
      targetAdminId: target.admin.id,
      resetBy: superAdmin.admin.email,
    });
    const stillThere = await prisma.adminUser.findUnique({ where: { id: target.admin.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.isActive).toBe(true);
  });

  it("rejects reset by a non-SUPER_ADMIN with 403", async () => {
    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: ["stores:view"] });
    const target = await createAdmin({ roleName: "TARGET2", keys: [] });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const res = await request(app)
      .post("/api/admin/auth/2fa/reset")
      .set("Authorization", `Bearer ${session.body.accessToken}`)
      .send({ adminUserId: target.admin.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("404s for an unknown target admin", async () => {
    const superAdmin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const session = await login(
      superAdmin.admin.email,
      superAdmin.password,
      generateTotpToken(superAdmin.secret),
    );
    const res = await request(app)
      .post("/api/admin/auth/2fa/reset")
      .set("Authorization", `Bearer ${session.body.accessToken}`)
      .send({ adminUserId: crypto.randomUUID() });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("admin RBAC", () => {
  it("grants a brand-new permission purely via data with zero schema changes (additive model)", async () => {
    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: [] });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );

    const denied = await request(app)
      .put("/api/admin/billing/pricing/PRO")
      .set("Authorization", `Bearer ${session.body.accessToken}`)
      .send({ monthlyPrice: 4999 });
    expect(denied.status).toBe(403);

    // Pure data: a new Permission row + one RolePermission binding. No schema.
    const permission = await prisma.permission.create({ data: { key: "billing:edit" } });
    await prisma.rolePermission.create({
      data: { roleId: support.role.id, permissionId: permission.id },
    });

    const granted = await request(app)
      .put("/api/admin/billing/pricing/PRO")
      .set("Authorization", `Bearer ${session.body.accessToken}`)
      .send({ monthlyPrice: 4999 });
    expect(granted.status).toBe(200);
  });

  it("allows a missing permission to be revoked by deleting the binding (edge case)", async () => {
    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: ["billing:edit"] });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const ok = await request(app)
      .put("/api/admin/billing/pricing/PRO")
      .set("Authorization", `Bearer ${session.body.accessToken}`)
      .send({ monthlyPrice: 5000 });
    expect(ok.status).toBe(200);

    await prisma.rolePermission.deleteMany({ where: { roleId: support.role.id } });
    const revoked = await request(app)
      .put("/api/admin/billing/pricing/PRO")
      .set("Authorization", `Bearer ${session.body.accessToken}`)
      .send({ monthlyPrice: 5000 });
    expect(revoked.status).toBe(403);
  });
});

describe("admin audit log", () => {
  it("lists audit entries to SUPER_ADMIN, rejecting SUPPORT (role gate)", async () => {
    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: SUPER_KEYS });
    const supportSession = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const denied = await request(app)
      .get("/api/admin/audit-log")
      .set("Authorization", `Bearer ${supportSession.body.accessToken}`);
    // Granting audit:view is NOT enough — the endpoint demands the role.
    expect(denied.status).toBe(403);

    const superAdmin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const superSession = await login(
      superAdmin.admin.email,
      superAdmin.password,
      generateTotpToken(superAdmin.secret),
    );
    const res = await request(app)
      .get("/api/admin/audit-log")
      .set("Authorization", `Bearer ${superSession.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual(expect.any(Array));
    expect(
      res.body.items.some((item: { action: string }) => item.action === "admin.session.login"),
    ).toBe(true);
    // Performer email is resolved into the view.
    expect(res.body.items[0]?.adminEmail).toEqual(expect.any(String));
  });
});

describe("admin support tickets", () => {
  async function authenticatedAdmin(keys: string[] = [
    "admin:support.tickets.view",
    "admin:support.tickets.manage",
  ]) {
    const fixture = await createAdmin({ roleName: `SUPPORT_${crypto.randomUUID()}`, keys });
    const session = await login(
      fixture.admin.email,
      fixture.password,
      generateTotpToken(fixture.secret),
    );
    expect(session.status).toBe(200);
    return { ...fixture, auth: `Bearer ${session.body.accessToken}` };
  }

  it("is mounted at /api/admin/support/tickets and lists filtered tickets", async () => {
    const { store: firstStore } = await createTenant({ name: "First Support Store" });
    const { store: secondStore } = await createTenant({ name: "Second Support Store" });
    const assigned = await authenticatedAdmin();
    const ticket = await createSupportTicket(firstStore.id, {
      subject: "Urgent checkout issue",
      priority: "URGENT",
      status: "IN_PROGRESS",
      assignedAdminId: assigned.admin.id,
    });
    await createSupportTicket(secondStore.id, { subject: "Other issue", priority: "LOW" });

    const res = await request(app)
      .get("/api/admin/support/tickets")
      .query({ status: "IN_PROGRESS", priority: "URGENT", assignedAdminId: assigned.admin.id })
      .set("Authorization", assigned.auth);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: ticket.id,
      subject: "Urgent checkout issue",
      store: { id: firstStore.id, name: "First Support Store" },
      assignedAdmin: { id: assigned.admin.id, email: assigned.admin.email },
    });
    expect(res.body.nextCursor).toBeNull();
    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "admin.support_tickets.viewed", adminUserId: assigned.admin.id },
    });
    expect(audit).not.toBeNull();
  });

  it("supports limit and cursor pagination without duplicating tickets", async () => {
    const { store } = await createTenant();
    const admin = await authenticatedAdmin(["admin:support.tickets.view"]);
    const first = await createSupportTicket(store.id, {
      subject: "First",
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    const second = await createSupportTicket(store.id, {
      subject: "Second",
      createdAt: new Date("2026-08-01T11:00:00.000Z"),
    });
    await createSupportTicket(store.id, {
      subject: "Third",
      createdAt: new Date("2026-08-01T12:00:00.000Z"),
    });

    const firstPage = await request(app)
      .get("/api/admin/support/tickets")
      .query({ limit: 2 })
      .set("Authorization", admin.auth);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.items.map((item: { id: string }) => item.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app)
      .get("/api/admin/support/tickets")
      .query({ limit: 2, cursor: firstPage.body.nextCursor })
      .set("Authorization", admin.auth);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.items).toHaveLength(1);
    expect(secondPage.body.items[0].subject).toBe("Third");
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it("returns ticket details and messages, and rejects an unknown ticket", async () => {
    const { account, store } = await createTenant();
    const admin = await authenticatedAdmin();
    const ticket = await createSupportTicket(store.id, { subject: "Need help" });
    await createTicketMessage(ticket.id, {
      body: "Merchant message",
      authorType: "MERCHANT",
      authorAccountId: account.id,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    await createTicketMessage(ticket.id, {
      body: "Admin message",
      authorType: "ADMIN",
      authorAdminId: admin.admin.id,
      createdAt: new Date("2026-08-01T11:00:00.000Z"),
    });

    const detail = await request(app)
      .get(`/api/admin/support/tickets/${ticket.id}`)
      .set("Authorization", admin.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.ticket).toMatchObject({ id: ticket.id, subject: "Need help" });
    expect(detail.body.messages.map((message: { body: string }) => message.body)).toEqual([
      "Merchant message",
      "Admin message",
    ]);

    const missing = await request(app)
      .get(`/api/admin/support/tickets/${crypto.randomUUID()}`)
      .set("Authorization", admin.auth);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("TICKET_NOT_FOUND");
  });

  it("enforces separate view and manage permissions", async () => {
    const { store } = await createTenant();
    const ticket = await createSupportTicket(store.id);
    const viewer = await authenticatedAdmin(["admin:support.tickets.view"]);

    const list = await request(app)
      .get("/api/admin/support/tickets")
      .set("Authorization", viewer.auth);
    expect(list.status).toBe(200);

    const assign = await request(app)
      .post(`/api/admin/support/tickets/${ticket.id}/assign`)
      .set("Authorization", viewer.auth)
      .send({ adminId: null });
    expect(assign.status).toBe(403);
    expect(assign.body.error.code).toBe("ACCESS_DENIED");

    const unauthenticated = await request(app).get("/api/admin/support/tickets");
    expect(unauthenticated.status).toBe(401);
  });

  it("assigns and unassigns active admins, rejecting invalid targets", async () => {
    const { store } = await createTenant();
    const admin = await authenticatedAdmin();
    const target = await createAdmin({ roleName: `TARGET_${crypto.randomUUID()}`, keys: [] });
    const ticket = await createSupportTicket(store.id);

    const assigned = await request(app)
      .post(`/api/admin/support/tickets/${ticket.id}/assign`)
      .set("Authorization", admin.auth)
      .send({ adminId: target.admin.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.ticket.assignedAdmin.id).toBe(target.admin.id);

    const unassigned = await request(app)
      .post(`/api/admin/support/tickets/${ticket.id}/assign`)
      .set("Authorization", admin.auth)
      .send({ adminId: null });
    expect(unassigned.status).toBe(200);
    expect(unassigned.body.ticket.assignedAdmin).toBeNull();

    const invalid = await request(app)
      .post(`/api/admin/support/tickets/${ticket.id}/assign`)
      .set("Authorization", admin.auth)
      .send({ adminId: crypto.randomUUID() });
    expect(invalid.status).toBe(404);
    expect(invalid.body.error.code).toBe("ADMIN_NOT_FOUND");
  });

  it("changes status, records timestamps, and creates admin replies", async () => {
    const { store } = await createTenant();
    const admin = await authenticatedAdmin();
    const ticket = await createSupportTicket(store.id);

    const resolved = await request(app)
      .patch(`/api/admin/support/tickets/${ticket.id}/status`)
      .set("Authorization", admin.auth)
      .send({ status: "RESOLVED" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.ticket.status).toBe("RESOLVED");
    expect(resolved.body.ticket.resolvedAt).toEqual(expect.any(String));

    const reply = await request(app)
      .post(`/api/admin/support/tickets/${ticket.id}/messages`)
      .set("Authorization", admin.auth)
      .send({ body: "We are investigating this now." });
    expect(reply.status).toBe(201);
    expect(reply.body.message).toMatchObject({
      ticketId: ticket.id,
      authorType: "ADMIN",
      authorAdminId: admin.admin.id,
      body: "We are investigating this now.",
    });

    const closed = await request(app)
      .patch(`/api/admin/support/tickets/${ticket.id}/status`)
      .set("Authorization", admin.auth)
      .send({ status: "CLOSED" });
    expect(closed.status).toBe(200);
    expect(closed.body.ticket.closedAt).toEqual(expect.any(String));

    const rejectedReply = await request(app)
      .post(`/api/admin/support/tickets/${ticket.id}/messages`)
      .set("Authorization", admin.auth)
      .send({ body: "This should be rejected." });
    expect(rejectedReply.status).toBe(409);
    expect(rejectedReply.body.error.code).toBe("TICKET_CLOSED");

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "admin.support_ticket.replied", adminUserId: admin.admin.id },
    });
    expect(audit?.detail).toMatchObject({ ticketId: ticket.id, messageId: reply.body.message.id });
    expect(JSON.stringify(audit?.detail)).not.toContain("We are investigating this now.");
  });

  it("treats closed tickets as terminal", async () => {
    const { store } = await createTenant();
    const admin = await authenticatedAdmin();
    const ticket = await createSupportTicket(store.id, { status: "CLOSED" });

    const status = await request(app)
      .patch(`/api/admin/support/tickets/${ticket.id}/status`)
      .set("Authorization", admin.auth)
      .send({ status: "OPEN" });
    expect(status.status).toBe(409);
    expect(status.body.error.code).toBe("TICKET_CLOSED");
  });
});

describe("store support & ops", () => {
  it("searches stores by name/owner email with subscription filters (happy path)", async () => {
    const { store } = await createTenant({ name: "Zebra Mart" });
    await attachSubscription(store.id, { tier: "PRO", status: "ACTIVE" });

    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: ["stores:view"] });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const auth = `Bearer ${session.body.accessToken}`;

    const byName = await request(app)
      .get("/api/admin/stores/search")
      .query({ q: "Zebra" })
      .set("Authorization", auth);
    expect(byName.status).toBe(200);
    expect(byName.body.items[0]).toMatchObject({
      name: "Zebra Mart",
      tier: "PRO",
      subscriptionStatus: "ACTIVE",
    });

    const byTier = await request(app)
      .get("/api/admin/stores/search")
      .query({ tier: "pro" })
      .set("Authorization", auth);
    expect(byTier.body.items.some((item: { id: string }) => item.id === store.id)).toBe(true);

    const activeOnly = await request(app)
      .get("/api/admin/stores/search")
      .query({ subscriptionStatus: "inactive" })
      .set("Authorization", auth);
    expect(activeOnly.body.items.some((item: { id: string }) => item.id === store.id)).toBe(false);
  });

  it("returns a full support view of one store (plan, staff, orders, webhook health)", async () => {
    const { store } = await createTenant({ name: "Detail Shop" });
    await attachSubscription(store.id, { tier: "PRO", status: "ACTIVE" });
    await createProductRow(store.id, "Coffee", 10);
    await createOrderRow(store.id, {
      createdAt: new Date(Date.now() - 3_600_000),
      status: "PAID",
      total: 25,
    });
    await prisma.webhookEvent.create({
      data: {
        storeId: store.id,
        provider: "PAYSTACK",
        externalEventId: `evt-${crypto.randomUUID()}`,
        payload: { event: "charge.success", data: { id: "x", reference: "ref" } },
        status: "PROCESSED",
        processedAt: new Date(Date.now() - 3_000_000),
      },
    });

    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: ["stores:view"] });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const res = await request(app)
      .get(`/api/admin/stores/${store.id}`)
      .set("Authorization", `Bearer ${session.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({ tier: "PRO", status: "ACTIVE" });
    expect(res.body.recentOrders).toHaveLength(1);
    expect(res.body.paymentProvider.webhookHealth.lastEvents[0].status).toBe("processed");

    const missing = await request(app)
      .get("/api/admin/stores/00000000-0000-7000-8000-000000000000")
      .set("Authorization", `Bearer ${session.body.accessToken}`);
    expect(missing.status).toBe(404);
  });
});

describe("health metrics", () => {
  it("signups-over-time buckets UTC store creation days (happy path)", async () => {
    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: ["stores:view"] });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const auth = `Bearer ${session.body.accessToken}`;

    await createTenant({ createdAt: new Date("2026-08-10T08:00:00.000Z") });
    await createTenant({ createdAt: new Date("2026-08-10T23:00:00.000Z") });
    await createTenant({ createdAt: new Date("2026-08-12T12:00:00.000Z") });

    const res = await request(app)
      .get("/api/admin/health/signups")
      .query({
        start: "2026-08-10T00:00:00.000Z",
        end: "2026-08-13T00:00:00.000Z",
        granularity: "daily",
      })
      .set("Authorization", auth);
    expect(res.status).toBe(200);
    const day = (d: string) =>
      res.body.buckets.find((b: { start: string }) => b.start === d)?.count ?? -1;
    expect(day("2026-08-10T00:00:00.000Z")).toBe(2);
    expect(day("2026-08-11T00:00:00.000Z")).toBe(0);
    expect(day("2026-08-12T00:00:00.000Z")).toBe(1);
  });

  it("activation rate uses the shared 24h published-product proxy (happy path)", async () => {
    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: ["stores:view"] });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const auth = `Bearer ${session.body.accessToken}`;

    const { store: activated } = await createTenant({
      createdAt: new Date("2026-08-11T00:00:00.000Z"),
    });
    const { store: sluggish } = await createTenant({
      createdAt: new Date("2026-08-11T02:00:00.000Z"),
    });
    await createProductRow(activated.id, "Fast Product", 5, new Date("2026-08-11T10:00:00.000Z"));
    await createProductRow(sluggish.id, "Late Product", 5, new Date("2026-08-12T06:00:00.000Z")); // 28h late

    const res = await request(app)
      .get("/api/admin/health/activation")
      .query({ start: "2026-08-11T00:00:00.000Z", end: "2026-08-13T00:00:00.000Z" })
      .set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ createdStores: 2, activatedStores: 1, activationRate: 50 });
  });

  it("subscription health breaks down by status/tier and computes MRR from the pricing table", async () => {
    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: ["stores:view"] });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const auth = `Bearer ${session.body.accessToken}`;
    await seedDefaultPricing();

    const { store: pro } = await createTenant();
    const { store: ent } = await createTenant();
    const { store: starter } = await createTenant();
    await attachSubscription(pro.id, { tier: "PRO", status: "ACTIVE" });
    await attachSubscription(ent.id, { tier: "ENTERPRISE", status: "ACTIVE" });
    await attachSubscription(starter.id, { tier: "STARTER", status: "ACTIVE" });

    const res = await request(app)
      .get("/api/admin/health/subscriptions")
      .set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.metrics.activeSubscriptions).toBeGreaterThanOrEqual(3);
    const proRow = res.body.byTier.find((t: { tier: string }) => t.tier === "pro");
    expect(proRow.monthlyPrice).toBe(4900);
    const mrr = Number(res.body.metrics.mrr);
    expect(mrr).toBeGreaterThanOrEqual(4900 + 19000);
  });

  it("churn rates churned stores against ACTIVE-at-start, excluding new subscriptions", async () => {
    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: ["stores:view"] });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const auth = `Bearer ${session.body.accessToken}`;

    const { store: loyal } = await createTenant();
    const { store: churned } = await createTenant();
    const { store: newSub } = await createTenant();
    await attachSubscription(loyal.id, {
      tier: "PRO",
      status: "ACTIVE",
      createdAt: new Date("2026-07-05T00:00:00.000Z"),
    });
    await attachSubscription(churned.id, {
      tier: "PRO",
      status: "CANCELLED",
      createdAt: new Date("2026-07-05T00:00:00.000Z"),
      updatedAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    // Created DURING the period → excluded from the denominator by the definition.
    await attachSubscription(newSub.id, {
      tier: "PRO",
      status: "ACTIVE",
      createdAt: new Date("2026-08-15T00:00:00.000Z"),
      updatedAt: new Date("2026-08-15T00:00:00.000Z"),
    });

    const res = await request(app)
      .get("/api/admin/health/churn")
      .query({ start: RANGE_START, end: RANGE_END })
      .set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.activeAtPeriodStart).toBe(1);
    expect(res.body.churned).toBe(1);
    expect(res.body.churnRate).toBe(100);
  });
});

describe("billing pricing (admin-mutable, single source of truth)", () => {
  it("reads defaults, updates a price, and MRR reflects the new value immediately", async () => {
    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: ["stores:view"] });
    const supportSession = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const superAdmin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const superSession = await login(
      superAdmin.admin.email,
      superAdmin.password,
      generateTotpToken(superAdmin.secret),
    );
    const supportAuth = `Bearer ${supportSession.body.accessToken}`;
    const superAuth = `Bearer ${superSession.body.accessToken}`;
    await seedDefaultPricing();

    const initial = await request(app)
      .get("/api/admin/billing/pricing")
      .set("Authorization", supportAuth);
    expect(initial.status).toBe(200);
    const pro = initial.body.items.find((i: { plan: string }) => i.plan === "pro");
    expect(pro.monthlyPrice).toBe(4900);

    const { store } = await createTenant();
    await attachSubscription(store.id, { tier: "PRO", status: "ACTIVE" });
    const before = await request(app)
      .get("/api/admin/health/subscriptions")
      .set("Authorization", supportAuth);
    expect(Number(before.body.metrics.mrr)).toBeGreaterThanOrEqual(4900);

    const updated = await request(app)
      .put("/api/admin/billing/pricing/PRO")
      .set("Authorization", superAuth)
      .send({ monthlyPrice: 5999 });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ plan: "pro", monthlyPrice: 5999 });

    const after = await request(app)
      .get("/api/admin/health/subscriptions")
      .set("Authorization", supportAuth);
    expect(Number(after.body.metrics.mrr)).toBeGreaterThanOrEqual(5999);

    const audit = await request(app).get("/api/admin/audit-log").set("Authorization", superAuth);
    expect(
      audit.body.items.some((i: { action: string }) => i.action === "billing.pricing.updated"),
    ).toBe(true);

    const invalidPlan = await request(app)
      .put("/api/admin/billing/pricing/FREEMIUM")
      .set("Authorization", superAuth)
      .send({ monthlyPrice: 100 });
    expect(invalidPlan.status).toBe(400);

    const freePlan = await request(app)
      .put("/api/admin/billing/pricing/STARTER")
      .set("Authorization", superAuth)
      .send({ monthlyPrice: null });
    expect(freePlan.status).toBe(200);
  });
});

describe("webhook reprocess (operations)", () => {
  it("replays a FAILED event through the fulfillment pipeline, never twice (happy + sad)", async () => {
    const { store } = await createTenant();
    const { order, product } = await createOrderRow(store.id, {
      createdAt: new Date(Date.now() - 3_600_000),
      status: "PENDING",
      total: 20,
      paymentReference: `ref-${crypto.randomUUID()}`,
    });
    await prisma.webhookEvent.create({
      data: {
        storeId: store.id,
        provider: "PAYSTACK",
        externalEventId: `evt-${crypto.randomUUID()}`,
        payload: {
          event: "charge.success",
          data: { id: "evt-replay", reference: order.paymentReference },
        },
        status: "FAILED",
      },
    });

    const admin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const session = await login(admin.admin.email, admin.password, generateTotpToken(admin.secret));
    const auth = `Bearer ${session.body.accessToken}`;

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { storeId: store.id } });

    const replayed = await request(app)
      .post(`/api/admin/webhook-events/${event.id}/reprocess`)
      .set("Authorization", auth);
    expect(replayed.status).toBe(200);
    expect(replayed.body.outcome).toBe("PROCESSED");

    const paidOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(paidOrder.status).toBe("PAID");
    const productAfter = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(productAfter.quantity).toBe(98); // 100 - 2 sold

    const replayedAgain = await request(app)
      .post(`/api/admin/webhook-events/${event.id}/reprocess`)
      .set("Authorization", auth);
    expect(replayedAgain.status).toBe(409);

    const unknown = await request(app)
      .post("/api/admin/webhook-events/00000000-0000-7000-8000-000000000000/reprocess")
      .set("Authorization", auth);
    expect(unknown.status).toBe(404);
  });
});

describe("trust & integrity", () => {
  it("flags ledger-vs-quantity mismatches (LEDGER_MISMATCH) and keeps clean stores silent", async () => {
    const { store, mainBranch } = await createTenant({ name: "Ledger Shop" });
    const product = await createProductRow(store.id, "Mismatched SKU", 5);
    await prisma.stockLedgerEntry.create({
      data: {
        storeId: store.id,
        branchId: mainBranch.id,
        productId: product.id,
        quantityChange: 10,
        reason: "RESTOCK",
      },
    });
    const { store: cleanStore, mainBranch: cleanMainBranch } = await createTenant({
      name: "Clean Shop",
    });
    const cleanProduct = await createProductRow(cleanStore.id, "Clean SKU", 7);
    await prisma.stockLedgerEntry.create({
      data: {
        storeId: cleanStore.id,
        branchId: cleanMainBranch.id,
        productId: cleanProduct.id,
        quantityChange: 7,
        reason: "RESTOCK",
      },
    });

    const admin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const session = await login(admin.admin.email, admin.password, generateTotpToken(admin.secret));
    const res = await request(app)
      .get("/api/admin/integrity/ledger-anomalies")
      .set("Authorization", `Bearer ${session.body.accessToken}`);

    expect(res.status).toBe(200);
    const mismatch = res.body.items.find((i: { productId: string }) => i.productId === product.id);
    expect(mismatch).toMatchObject({ issue: "LEDGER_MISMATCH", ledgerTotal: 10 });
    expect(res.body.items.some((i: { productId: string }) => i.productId === cleanProduct.id)).toBe(
      false,
    );
  });

  it("ignores variant ledger rows in product-level reconciliation (variants hold their own stock)", async () => {
    const { store, mainBranch } = await createTenant();
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: "Shirt",
        price: 15,
        quantity: 0,
        variants: {
          create: [
            { storeId: store.id, name: "M", quantity: 5 },
            { storeId: store.id, name: "L", quantity: 9 },
          ],
        },
      },
    });
    await prisma.stockLedgerEntry.create({
      data: {
        storeId: store.id,
        branchId: mainBranch.id,
        productId: product.id,
        variantId: (await prisma.productVariant.findFirst({ where: { productId: product.id } }))!
          .id,
        quantityChange: 14,
        reason: "RESTOCK",
      },
    });

    const admin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const session = await login(admin.admin.email, admin.password, generateTotpToken(admin.secret));
    const res = await request(app)
      .get("/api/admin/integrity/ledger-anomalies")
      .set("Authorization", `Bearer ${session.body.accessToken}`);

    expect(res.status).toBe(200);
    const listed = res.body.items.find((i: { productId: string }) => i.productId === product.id);
    expect(listed).toBeUndefined();
  });

  it("lists only PENDING orders older than the window as orphaned (happy + edge)", async () => {
    const { store } = await createTenant();
    const { order: oldOrder } = await createOrderRow(store.id, {
      createdAt: new Date(Date.now() - 100 * 3_600_000),
      status: "PENDING",
    });
    const { order: freshOrder } = await createOrderRow(store.id, {
      createdAt: new Date(Date.now() - 1_000_000),
      status: "PENDING",
    });

    const admin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const session = await login(admin.admin.email, admin.password, generateTotpToken(admin.secret));
    const res = await request(app)
      .get("/api/admin/integrity/orphaned-orders")
      .set("Authorization", `Bearer ${session.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.windowHours).toBe(24);
    const listed = res.body.items.find((i: { orderId: string }) => i.orderId === oldOrder.id);
    expect(listed).toBeDefined();
    const freshListed = res.body.items.find(
      (i: { orderId: string }) => i.orderId === freshOrder.id,
    );
    expect(freshListed).toBeUndefined();
  });

  it("serves the moderation queue placeholder shape (pending pipeline)", async () => {
    const admin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const session = await login(admin.admin.email, admin.password, generateTotpToken(admin.secret));
    const res = await request(app)
      .get("/api/admin/moderation/flagged-content")
      .set("Authorization", `Bearer ${session.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.queue).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
  });
});

describe("admin refresh-token flow", () => {
  it("login returns a refresh token (rt_ prefix)", async () => {
    const admin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const session = await login(admin.admin.email, admin.password, generateTotpToken(admin.secret));
    expect(session.status).toBe(200);
    expect(session.body.refreshToken).toMatch(/^rt_/);
  });

  it("refreshes into a new access+refresh and rejects the old token as reuse", async () => {
    const admin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const session = await login(admin.admin.email, admin.password, generateTotpToken(admin.secret));
    const refreshToken = session.body.refreshToken as string;

    const refreshed = await request(app).post("/api/admin/auth/refresh").send({ refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toEqual(expect.any(String));
    expect(refreshed.body.refreshToken).toMatch(/^rt_/);
    expect(refreshed.body.refreshToken).not.toBe(refreshToken);

    const reused = await request(app).post("/api/admin/auth/refresh").send({ refreshToken });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe("TOKEN_REUSE_DETECTED");

    const again = await request(app)
      .post("/api/admin/auth/refresh")
      .send({ refreshToken: refreshed.body.refreshToken });
    expect(again.status).toBe(200);
  });

  it("rejects an expired admin refresh token with SESSION_EXPIRED", async () => {
    const admin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const session = await login(admin.admin.email, admin.password, generateTotpToken(admin.secret));

    await prisma.adminRefreshToken.updateMany({
      where: { adminId: admin.admin.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const res = await request(app)
      .post("/api/admin/auth/refresh")
      .send({ refreshToken: session.body.refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_EXPIRED");
  });

  it("rejects a garbage refresh token with INVALID_REFRESH_TOKEN", async () => {
    const res = await request(app)
      .post("/api/admin/auth/refresh")
      .send({ refreshToken: "not-a-token" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("logout revokes the presented refresh token", async () => {
    const admin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const session = await login(admin.admin.email, admin.password, generateTotpToken(admin.secret));
    const refreshToken = session.body.refreshToken as string;

    const logout = await request(app).post("/api/admin/auth/logout").send({ refreshToken });
    expect(logout.status).toBe(204);

    const after = await request(app).post("/api/admin/auth/refresh").send({ refreshToken });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("TOKEN_REUSE_DETECTED");
  });

  it("rotating 2FA revokes all refresh tokens (forces re-auth)", async () => {
    const admin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const session = await login(admin.admin.email, admin.password, generateTotpToken(admin.secret));
    const refreshToken = session.body.refreshToken as string;

    const rotated = await request(app)
      .post("/api/admin/auth/2fa/rotate")
      .set("Authorization", `Bearer ${session.body.accessToken}`);
    expect(rotated.status).toBe(200);

    const after = await request(app).post("/api/admin/auth/refresh").send({ refreshToken });
    expect(after.status).toBe(401);
  });
});

describe("admin awaiting bank-transfer confirmations", () => {
  const PAYMENT_QUEUE_KEY = "admin:payments.awaiting-confirmation.view";

  it("lists every tenant's claims oldest first, places legacy rows last, and audits the read", async () => {
    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: [PAYMENT_QUEUE_KEY] });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const first = await createStoreWithOwner({ name: "First Store" });
    const second = await createStoreWithOwner({ name: "Second Store" });
    const { order: oldest } = await createOrderRow(first.store.id, {
      createdAt: new Date("2026-08-01T08:00:00.000Z"),
      status: "AWAITING_PAYMENT",
      total: 1250,
    });
    const { order: newest } = await createOrderRow(second.store.id, {
      createdAt: new Date("2026-08-01T08:00:00.000Z"),
      status: "AWAITING_PAYMENT",
      total: 500,
    });
    const { order: legacy } = await createOrderRow(first.store.id, {
      createdAt: new Date("2026-08-01T08:00:00.000Z"),
      status: "AWAITING_PAYMENT",
      total: 75,
    });
    await createOrderRow(second.store.id, {
      createdAt: new Date("2026-08-01T08:00:00.000Z"),
      status: "PAID",
      total: 999,
    });
    await prisma.order.update({
      where: { id: oldest.id },
      data: { paymentSubmittedAt: new Date("2026-08-01T09:00:00.000Z") },
    });
    await prisma.order.update({
      where: { id: newest.id },
      data: { paymentSubmittedAt: new Date("2026-08-01T10:00:00.000Z") },
    });

    const res = await request(app)
      .get("/api/admin/payments/awaiting-confirmation")
      .set("Authorization", `Bearer ${session.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { orderId: string }) => item.orderId)).toEqual([
      oldest.id,
      newest.id,
      legacy.id,
    ]);
    expect(res.body.items[0]).toMatchObject({ storeName: "First Store", amount: "1250.00" });
    expect(res.body.items[0].waitingSeconds).toEqual(expect.any(Number));
    expect(res.body.items[2]).toMatchObject({ paymentSubmittedAt: null, waitingSeconds: null });
    expect(
      await prisma.adminAuditLog.count({
        where: { action: "admin.awaiting_payment_orders.viewed" },
      }),
    ).toBe(1);
  });

  it("denies admins without the queue permission and exposes no mutation route", async () => {
    const denied = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: [] });
    const session = await login(
      denied.admin.email,
      denied.password,
      generateTotpToken(denied.secret),
    );
    const auth = { Authorization: `Bearer ${session.body.accessToken}` };
    expect((await request(app).get("/api/admin/payments/awaiting-confirmation")).status).toBe(401);
    expect(
      (await request(app).get("/api/admin/payments/awaiting-confirmation").set(auth)).status,
    ).toBe(403);
    expect(
      (await request(app).post("/api/admin/payments/awaiting-confirmation").set(auth)).status,
    ).toBe(404);
    expect(
      (await request(app).patch("/api/admin/payments/awaiting-confirmation").set(auth)).status,
    ).toBe(404);
  });
});

describe("admin session metadata", () => {
  const STAFF_VIEW_KEY = "admin:staff.view";

  it("captures IP/device metadata at login and refresh rotation", async () => {
    const admin = await createAdmin({ roleName: "SUPER_ADMIN", keys: [STAFF_VIEW_KEY] });
    const session = await login(
      admin.admin.email,
      admin.password,
      generateTotpToken(admin.secret),
      {
        "User-Agent": "Brikoh Admin Desktop",
      },
    );
    const first = await prisma.adminRefreshToken.findFirstOrThrow({
      where: { adminId: admin.admin.id },
    });
    expect(first).toMatchObject({ userAgent: "Brikoh Admin Desktop", revokedAt: null });
    expect(first.ipAddress).toEqual(expect.any(String));

    const refreshed = await request(app)
      .post("/api/admin/auth/refresh")
      .set({ "User-Agent": "Brikoh Admin Mobile" })
      .send({ refreshToken: session.body.refreshToken });
    expect(refreshed.status).toBe(200);
    const tokens = await prisma.adminRefreshToken.findMany({
      where: { adminId: admin.admin.id },
      orderBy: { createdAt: "asc" },
    });
    expect(tokens[0]).toMatchObject({ revokedAt: expect.any(Date) });
    expect(tokens[1]).toMatchObject({ userAgent: "Brikoh Admin Mobile", revokedAt: null });
    expect(tokens[1]?.ipAddress).toEqual(expect.any(String));
  });

  it("shows only the latest usable session to a super admin and audits the read", async () => {
    const viewer = await createAdmin({ roleName: "SUPER_ADMIN", keys: [STAFF_VIEW_KEY] });
    const target = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: [] });
    const noSession = await createAdmin({ roleName: "OPERATIONS_ADMIN", keys: [] });
    await prisma.adminRefreshToken.createMany({
      data: [
        {
          adminId: target.admin.id,
          tokenId: "old-session",
          family: "old",
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: new Date(),
          ipAddress: "198.51.100.1",
          userAgent: "revoked",
        },
        {
          adminId: target.admin.id,
          tokenId: "expired-session",
          family: "expired",
          expiresAt: new Date(Date.now() - 1),
          ipAddress: "198.51.100.2",
          userAgent: "expired",
        },
        {
          adminId: target.admin.id,
          tokenId: "older-current-session",
          family: "older-current",
          expiresAt: new Date(Date.now() + 86_400_000),
          createdAt: new Date(Date.now() - 1_000),
          ipAddress: "198.51.100.4",
          userAgent: "older current",
        },
        {
          adminId: target.admin.id,
          tokenId: "current-session",
          family: "current",
          expiresAt: new Date(Date.now() + 86_400_000),
          createdAt: new Date(),
          ipAddress: "198.51.100.3",
          userAgent: "current",
        },
      ],
    });
    const session = await login(
      viewer.admin.email,
      viewer.password,
      generateTotpToken(viewer.secret),
    );
    const res = await request(app)
      .get("/api/admin/staff")
      .set("Authorization", `Bearer ${session.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(
      res.body.items.find((item: { id: string }) => item.id === target.admin.id),
    ).toMatchObject({
      session: { ipAddress: "198.51.100.3", userAgent: "current" },
    });
    expect(
      res.body.items.find((item: { id: string }) => item.id === noSession.admin.id),
    ).toMatchObject({
      session: null,
    });
    expect(await prisma.adminAuditLog.count({ where: { action: "admin.staff.viewed" } })).toBe(1);
  });

  it("requires the staff-view permission", async () => {
    const denied = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: [] });
    const session = await login(
      denied.admin.email,
      denied.password,
      generateTotpToken(denied.secret),
    );
    expect((await request(app).get("/api/admin/staff")).status).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/admin/staff")
          .set("Authorization", `Bearer ${session.body.accessToken}`)
      ).status,
    ).toBe(403);
  });
});

describe("admin platform views (overview / merchants / stores / orders)", () => {
  it("overview computes cross-tenant rollups for real and audits the read", async () => {
    const superAdmin = await createAdmin({ roleName: "SUPER_ADMIN", keys: SUPER_KEYS });
    const session = await login(
      superAdmin.admin.email,
      superAdmin.password,
      generateTotpToken(superAdmin.secret),
    );
    const auth = `Bearer ${session.body.accessToken}`;
    await seedDefaultPricing();

    const { store: storeA } = await createStoreWithOwner({ name: "Store A", currency: "NGN" });
    const { store: storeB } = await createStoreWithOwner({ name: "Store B", currency: "USD" });
    const { store: storeC } = await createStoreWithOwner({ name: "Store C", currency: "NGN" });
    await createStoreWithOwner({ name: "Store D", currency: "NGN" });
    await attachSubscription(storeA.id, { tier: "PRO", status: "ACTIVE" });
    await attachSubscription(storeB.id, { tier: "ENTERPRISE", status: "ACTIVE" });
    await attachSubscription(storeC.id, { tier: "STARTER", status: "TRIALING" });

    const recent = new Date(Date.now() - 3_600_000);
    await createOrderRow(storeA.id, { createdAt: recent, status: "PAID", total: 1000 });
    await createOrderRow(storeA.id, { createdAt: recent, status: "PAID", total: 500 });
    await createOrderRow(storeA.id, { createdAt: recent, status: "PENDING", total: 300 });
    await createOrderRow(storeA.id, { createdAt: recent, status: "CANCELLED", total: 100 });
    await createOrderRow(storeB.id, { createdAt: recent, status: "PAID", total: 20 });

    const res = await request(app).get("/api/admin/overview").set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.totalStores).toBe(4);
    expect(res.body.subscriptionsByStatus).toMatchObject({
      ACTIVE: 2,
      TRIALING: 1,
      PAST_DUE: 0,
      CANCELLED: 0,
    });
    expect(res.body.orderCountsByStatus).toMatchObject({
      PAID: 3,
      PENDING: 1,
      CANCELLED: 1,
    });
    const ngn = res.body.revenueByCurrency.find((r: { currency: string }) => r.currency === "NGN");
    const usd = res.body.revenueByCurrency.find((r: { currency: string }) => r.currency === "USD");
    expect(ngn.total).toBe(1500);
    expect(usd.total).toBe(20);
    expect(res.body.mrr).toBe(4900 + 19000);
    expect(res.body.mrrCurrency).toBe("NGN");

    const audit = await prisma.adminAuditLog.findMany({
      where: { action: "admin.overview.viewed" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.adminUserId).toBe(superAdmin.admin.id);
  });

  it("merchants lists one row per store with owner + 30d GMV and audits the read", async () => {
    const support = await createAdmin({
      roleName: "SUPPORT_ADMIN",
      keys: ["admin:merchants.view"],
    });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const auth = `Bearer ${session.body.accessToken}`;

    const { store } = await createStoreWithOwner({
      name: "Merchant Co",
      email: "owner-merch@test.example",
      currency: "NGN",
    });
    await attachSubscription(store.id, { tier: "PRO", status: "ACTIVE" });
    const recent = new Date(Date.now() - 3_600_000);
    const old = new Date(Date.now() - 40 * 86_400_000);
    await createOrderRow(store.id, { createdAt: recent, status: "PAID", total: 1000 });
    await createOrderRow(store.id, { createdAt: recent, status: "PAID", total: 500 });
    await createOrderRow(store.id, { createdAt: old, status: "PAID", total: 999 }); // outside 30d

    const res = await request(app).get("/api/admin/merchants").set("Authorization", auth);
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { id: string }) => i.id === store.id);
    expect(row).toMatchObject({
      storeName: "Merchant Co",
      ownerEmail: "owner-merch@test.example",
      tier: "pro",
      subscriptionStatus: "ACTIVE",
      gmvLast30d: 1500,
      gmvCurrency: "NGN",
      orderCount: 3,
    });

    // search by owner email narrows the result.
    const searched = await request(app)
      .get("/api/admin/merchants")
      .query({ q: "owner-merch@test.example" })
      .set("Authorization", auth);
    expect(searched.status).toBe(200);
    expect(searched.body.items).toHaveLength(1);
    expect(searched.body.items[0].id).toBe(store.id);

    const audit = await prisma.adminAuditLog.findMany({
      where: { action: "admin.merchants.viewed" },
    });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]!.detail).toMatchObject({ q: null });
  });

  it("stores fleet shows live product count vs cap and audits the read", async () => {
    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: ["admin:stores.view"] });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const auth = `Bearer ${session.body.accessToken}`;

    const { store } = await createStoreWithOwner({ name: "Fleet Shop", currency: "NGN" });
    await attachSubscription(store.id, {
      tier: "PRO",
      status: "ACTIVE",
      productCap: 500,
    });
    await createProductRow(store.id, "SKU 1", 10);
    await createProductRow(store.id, "SKU 2", 10);
    await createProductRow(store.id, "SKU 3", 10);

    const res = await request(app).get("/api/admin/stores").set("Authorization", auth);
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { id: string }) => i.id === store.id);
    expect(row).toMatchObject({
      name: "Fleet Shop",
      tier: "pro",
      subscriptionStatus: "ACTIVE",
      productCount: 3,
      productCap: 500,
      status: "ACTIVE",
      currency: "NGN",
    });

    const audit = await prisma.adminAuditLog.findMany({
      where: { action: "admin.stores.viewed" },
    });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("orders lists a cross-tenant log with status filter + search and audits the read", async () => {
    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: ["admin:orders.view"] });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const auth = `Bearer ${session.body.accessToken}`;

    const { store } = await createStoreWithOwner({ name: "Order Store", currency: "NGN" });
    const paid = await createOrderRow(store.id, {
      createdAt: new Date(Date.now() - 3_600_000),
      status: "PAID",
      total: 1000,
    });
    await createOrderRow(store.id, {
      createdAt: new Date(Date.now() - 3_600_000),
      status: "PENDING",
      total: 50,
    });

    const all = await request(app).get("/api/admin/orders").set("Authorization", auth);
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(2);

    const paidOnly = await request(app)
      .get("/api/admin/orders")
      .query({ status: "PAID" })
      .set("Authorization", auth);
    expect(paidOnly.status).toBe(200);
    expect(paidOnly.body.items).toHaveLength(1);
    expect(Number(paidOnly.body.items[0].total)).toBe(1000);

    const byNumber = await request(app)
      .get("/api/admin/orders")
      .query({ q: paid.order.orderNumber })
      .set("Authorization", auth);
    expect(byNumber.status).toBe(200);
    expect(byNumber.body.items).toHaveLength(1);

    // invalid status enum → 400
    const bad = await request(app)
      .get("/api/admin/orders")
      .query({ status: "NOPE" })
      .set("Authorization", auth);
    expect(bad.status).toBe(400);

    const audit = await prisma.adminAuditLog.findMany({
      where: { action: "admin.orders.viewed" },
    });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]!.detail).toMatchObject({ status: null, q: null });
  });

  it("gates each view on its own permission key (granular RBAC)", async () => {
    const support = await createAdmin({ roleName: "SUPPORT_ADMIN", keys: ["stores:view"] });
    const session = await login(
      support.admin.email,
      support.password,
      generateTotpToken(support.secret),
    );
    const auth = `Bearer ${session.body.accessToken}`;

    // No admin:* key bound → every new view is denied.
    for (const path of ["/overview", "/merchants", "/stores", "/orders"]) {
      const res = await request(app).get(`/api/admin${path}`).set("Authorization", auth);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ACCESS_DENIED");
    }

    // A support admin with only merchants.view can read merchants but not
    // the other views — proving the keys are independent.
    const merchantsOnly = await createAdmin({
      roleName: "SUPPORT_MERCH_ONLY",
      keys: ["admin:merchants.view"],
    });
    const mSession = await login(
      merchantsOnly.admin.email,
      merchantsOnly.password,
      generateTotpToken(merchantsOnly.secret),
    );
    const mAuth = `Bearer ${mSession.body.accessToken}`;
    expect(
      (await request(app).get("/api/admin/merchants").set("Authorization", mAuth)).status,
    ).toBe(200);
    expect((await request(app).get("/api/admin/stores").set("Authorization", mAuth)).status).toBe(
      403,
    );
    expect((await request(app).get("/api/admin/orders").set("Authorization", mAuth)).status).toBe(
      403,
    );
    // The financial rollup is reserved for SUPER_ADMIN even with other keys.
    expect((await request(app).get("/api/admin/overview").set("Authorization", mAuth)).status).toBe(
      403,
    );
  });

  it("rejects unauthenticated access to every view with 401", async () => {
    for (const path of ["/overview", "/merchants", "/stores", "/orders"]) {
      const res = await request(app).get(`/api/admin${path}`);
      expect(res.status).toBe(401);
    }
  });
});
