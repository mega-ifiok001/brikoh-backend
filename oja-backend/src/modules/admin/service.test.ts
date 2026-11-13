import bcrypt from "bcrypt";
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { generateTotpSecret, generateTotpToken } from "./totp.js";
import { AdminService, type AdminDb } from "./service.js";

/**
 * Unit tests for AdminService with the Prisma surface stubbed. The
 * password hashing (bcrypt), TOTP codes (otplib) and JWT signing run for
 * REAL — only the database rows are canned, so the challenge/response
 * loop is proven here and only re-proven over HTTP in the integration
 * suite.
 */

const PASSWORD = "password-123";

function stubDb(overrides: Record<string, unknown> = {}): AdminDb {
  const defaults = {
    adminRefreshToken: {
      create: vi.fn(async (x: unknown) => x),
      update: vi.fn(async (x: unknown) => x),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findUnique: vi.fn(async () => null),
    },
  };
  return { ...defaults, ...overrides } as unknown as AdminDb;
}

function adminRow(email: string, roleName: string) {
  return {
    id: "admin-uuid-1",
    email,
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    twoFactorSecret: generateTotpSecret(),
    isActive: true,
    roleId: "role-uuid",
    createdAt: new Date(),
    updatedAt: new Date(),
    role: { name: roleName },
  };
}

async function serviceFor(db: AdminDb) {
  return new AdminService(db);
}

describe("AdminService.login", () => {
  it("returns an admin session after password + TOTP verification (happy path)", async () => {
    const row = adminRow("admin@brikoh.dev", "SUPER_ADMIN");
    const db = stubDb({
      adminUser: {
        findUnique: vi.fn(async () => row),
      },
      adminAuditLog: {
        create: vi.fn(async (x: unknown) => x),
      },
    });
    const service = await serviceFor(db);

    const session = await service.login(
      row.email,
      PASSWORD,
      generateTotpToken(row.twoFactorSecret),
    );

    expect(session.admin.email).toBe("admin@brikoh.dev");
    expect(session.admin.roleName).toBe("SUPER_ADMIN");
    expect(session.accessToken).toEqual(expect.any(String));
    // Login is recorded in the audit log.
    expect(db.adminAuditLog.create).toHaveBeenCalledOnce();
  });

  it("persists the supplied request IP and device hint with a new refresh token", async () => {
    const row = adminRow("admin@brikoh.dev", "SUPER_ADMIN");
    const db = stubDb({
      adminUser: { findUnique: vi.fn(async () => row) },
      adminAuditLog: { create: vi.fn(async (x: unknown) => x) },
    });
    const service = await serviceFor(db);

    await service.login(row.email, PASSWORD, generateTotpToken(row.twoFactorSecret), {
      ipAddress: "203.0.113.7",
      userAgent: "Brikoh Admin Desktop",
    });

    expect(db.adminRefreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminId: row.id,
          ipAddress: "203.0.113.7",
          userAgent: "Brikoh Admin Desktop",
        }),
      }),
    );
  });

  it("rejects an unknown email as a single 401 (sad path)", async () => {
    const db = stubDb({ adminUser: { findUnique: vi.fn(async () => null) } });
    const service = await serviceFor(db);
    await expect(service.login("nobody@brikoh.dev", PASSWORD, "123456")).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("rejects a wrong password (sad path)", async () => {
    const row = adminRow("admin@brikoh.dev", "SUPER_ADMIN");
    const db = stubDb({ adminUser: { findUnique: vi.fn(async () => row) } });
    const service = await serviceFor(db);
    await expect(service.login(row.email, "wrong-password", "123456")).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("rejects an invalid TOTP even with valid credentials (sad path — 2FA is mandatory)", async () => {
    const row = adminRow("admin@brikoh.dev", "SUPER_ADMIN");
    const db = stubDb({ adminUser: { findUnique: vi.fn(async () => row) } });
    const service = await serviceFor(db);
    await expect(service.login(row.email, PASSWORD, "000000")).rejects.toMatchObject({
      statusCode: 401,
      code: "2FA_INVALID",
    });
  });

  it("rejects a deactivated admin (sad path)", async () => {
    const row = { ...adminRow("admin@brikoh.dev", "SUPER_ADMIN"), isActive: false };
    const db = stubDb({ adminUser: { findUnique: vi.fn(async () => row) } });
    const service = await serviceFor(db);
    await expect(
      service.login(row.email, PASSWORD, generateTotpToken(row.twoFactorSecret)),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("AdminService.getAuthContext", () => {
  it("loads the admin with role and resolved permission keys", async () => {
    const db = stubDb({
      adminUser: {
        findUnique: vi.fn(async () => adminRow("admin@brikoh.dev", "SUPPORT_ADMIN")),
      },
      rolePermission: {
        findMany: vi.fn(async () => [{ permission: { key: "stores:view" } }]),
      },
    });
    const service = await serviceFor(db);
    const ctx = await service.getAuthContext("admin-uuid-1");
    expect(ctx.roleName).toBe("SUPPORT_ADMIN");
    expect(ctx.permissions).toEqual(["stores:view"]);
  });
});

describe("AdminService.listAwaitingPaymentOrders", () => {
  it("uses one supplied clock for waits, keeps missing claim timestamps last, and audits", async () => {
    const db = stubDb({
      order: {
        findMany: vi.fn(async () => [
          {
            id: "legacy",
            orderNumber: "ORD-003",
            total: new Prisma.Decimal(75),
            paymentSubmittedAt: null,
            store: { id: "store-a", name: "First Store", currency: "NGN" },
          },
          {
            id: "newer",
            orderNumber: "ORD-002",
            total: new Prisma.Decimal(500),
            paymentSubmittedAt: new Date("2026-08-01T11:00:00.000Z"),
            store: { id: "store-b", name: "Second Store", currency: "NGN" },
          },
          {
            id: "older",
            orderNumber: "ORD-001",
            total: new Prisma.Decimal(1250),
            paymentSubmittedAt: new Date("2026-08-01T10:00:00.000Z"),
            store: { id: "store-a", name: "First Store", currency: "NGN" },
          },
        ]),
      },
      adminAuditLog: { create: vi.fn(async (x: unknown) => x) },
    });
    const service = await serviceFor(db);

    const result = await service.listAwaitingPaymentOrders(
      "admin-uuid-1",
      new Date("2026-08-01T12:00:00.000Z"),
    );

    expect(result.items).toEqual([
      expect.objectContaining({ orderId: "older", amount: "1250.00", waitingSeconds: 7200 }),
      expect.objectContaining({ orderId: "newer", amount: "500.00", waitingSeconds: 3600 }),
      expect.objectContaining({
        orderId: "legacy",
        paymentSubmittedAt: null,
        waitingSeconds: null,
      }),
    ]);
    expect(db.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "admin.awaiting_payment_orders.viewed" }),
      }),
    );
  });
});

describe("AdminService.listAuditLog", () => {
  it("is SUPER_ADMIN-only: a support admin is rejected 403 (sad path)", async () => {
    const db = stubDb({});
    const service = await serviceFor(db);
    await expect(
      service.listAuditLog({ roleName: "SUPPORT_ADMIN", adminUserId: "x" }, { limit: 50 }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("returns audit rows with the performer email, newest first (happy path)", async () => {
    const db = stubDb({
      adminAuditLog: {
        findMany: vi.fn(async () => [
          {
            id: "log-1",
            adminUserId: "admin-uuid-1",
            action: "billing.pricing.updated",
            storeId: null,
            detail: { plan: "PRO" },
            createdAt: new Date("2026-08-05T12:00:00.000Z"),
          },
        ]),
      },
      adminUser: {
        findMany: vi.fn(async () => [{ id: "admin-uuid-1", email: "admin@brikoh.dev" }]),
      },
    });
    const service = await serviceFor(db);
    const result = await service.listAuditLog(
      { roleName: "SUPER_ADMIN", adminUserId: "x" },
      { limit: 50 },
    );
    expect(result.items[0]?.adminEmail).toBe("admin@brikoh.dev");
    expect(result.items[0]?.action).toBe("billing.pricing.updated");
    expect(result.nextCursor).toBeNull();
  });
});

describe("AdminService.updatePricing", () => {
  it("upserts the price and writes an audit entry (happy path)", async () => {
    const db = stubDb({
      subscriptionPlanSetting: {
        upsert: vi.fn(async () => ({
          plan: "PRO",
          monthlyPrice: new Prisma.Decimal(5999),
          updatedAt: new Date(),
        })),
      },
      adminAuditLog: { create: vi.fn(async (x: unknown) => x) },
    });
    const service = await serviceFor(db);
    await service.updatePricing("PRO", 5999, "admin-uuid-1");
    expect(db.subscriptionPlanSetting.upsert).toHaveBeenCalledOnce();
    expect(db.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "billing.pricing.updated" }),
      }),
    );
  });

  it("accepts a null price (free/excluded plan) (edge case)", async () => {
    const db = stubDb({
      subscriptionPlanSetting: {
        upsert: vi.fn(async () => ({
          plan: "STARTER",
          monthlyPrice: null,
          updatedAt: new Date(),
        })),
      },
      adminAuditLog: { create: vi.fn(async (x: unknown) => x) },
    });
    const service = await serviceFor(db);
    await expect(service.updatePricing("STARTER", null, "admin-uuid-1")).resolves.toBeDefined();
  });
});

describe("AdminService.getSubscriptionHealth", () => {
  it("computes MRR from the mutable pricing table, not code (happy path)", async () => {
    const db = stubDb({
      subscription: {
        groupBy: vi
          .fn()
          .mockResolvedValueOnce([
            { status: "ACTIVE", _count: 3 },
            { status: "CANCELLED", _count: 1 },
          ])
          .mockResolvedValueOnce([
            { tier: "PRO", _count: 2 },
            { tier: "ENTERPRISE", _count: 1 },
          ]),
      },
      subscriptionPlanSetting: {
        findMany: vi.fn(async () => [
          { plan: "STARTER", monthlyPrice: null },
          { plan: "PRO", monthlyPrice: new Prisma.Decimal("4900.00") },
          { plan: "ENTERPRISE", monthlyPrice: new Prisma.Decimal("19000.00") },
        ]),
      },
    });
    const service = await serviceFor(db);
    const health = await service.getSubscriptionHealth();

    expect(health.metrics.activeSubscriptions).toBe(3);
    // 2 × 4900 + 1 × 19000
    expect(health.metrics.mrr).toBe("28800.00");
    // byTier tiers are lowercase; the STARTER plan (null price) is present
    // even though it has zero active subscriptions.
    expect(health.byTier.find((t) => t.tier === "starter")?.monthlyPrice).toBeNull();
  });

  it("excludes plans priced null from MRR (edge case)", async () => {
    const db = stubDb({
      subscription: {
        groupBy: vi
          .fn()
          .mockResolvedValueOnce([{ status: "ACTIVE", _count: 1 }])
          .mockResolvedValueOnce([{ tier: "STARTER", _count: 1 }]),
      },
      subscriptionPlanSetting: {
        findMany: vi.fn(async () => [{ plan: "STARTER", monthlyPrice: null }]),
      },
    });
    const service = await serviceFor(db);
    const health = await service.getSubscriptionHealth();
    expect(health.metrics.mrr).toBe("0.00");
  });
});

describe("AdminService.getChurn (official definition)", () => {
  it("rates churn against stores ACTIVE at period start, excluding new subscriptions (happy path)", async () => {
    const db = stubDb({
      subscription: {
        // Pass 1: rows that existed before the period and are ACTIVE now
        // (a store appears once — duplicates deduped).
        // Pass 2: rows that transitioned to a churned status in the period.
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ storeId: "s1" }, { storeId: "s2" }, { storeId: "s1" }])
          .mockResolvedValueOnce([{ storeId: "s2" }]),
      },
    });
    const service = await serviceFor(db);
    const result = await service.getChurn(
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-09-01T00:00:00.000Z"),
    );
    expect(result.activeAtPeriodStart).toBe(2);
    expect(result.churned).toBe(1);
    expect(result.churnRate).toBe(50);
  });

  it("returns a null rate when nothing was active at period start (edge case)", async () => {
    const db = stubDb({
      subscription: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const service = await serviceFor(db);
    const result = await service.getChurn(
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-09-01T00:00:00.000Z"),
    );
    expect(result.activeAtPeriodStart).toBe(0);
    expect(result.churnRate).toBeNull();
  });
});

describe("AdminService.getActivation (operational proxy)", () => {
  it("counts stores with a product created within 24h of store creation (happy path)", async () => {
    const storeCreated = new Date("2026-08-05T00:00:00.000Z");
    const db = stubDb({
      store: {
        count: vi.fn(async () => 2),
        findMany: vi.fn(async () => [
          { id: "s1", createdAt: storeCreated },
          { id: "s2", createdAt: new Date("2026-08-05T10:00:00.000Z") },
        ]),
      },
      product: {
        findMany: vi.fn(async () => [
          // s1 published a product 10h after creation → activated.
          { storeId: "s1", createdAt: new Date(storeCreated.getTime() + 10 * 3_600_000) },
          // s2's only product came 30h after creation → NOT activated.
          { storeId: "s2", createdAt: new Date("2026-08-06T16:00:00.000Z") },
        ]),
      },
    });
    const service = await serviceFor(db);
    const result = await service.getActivation(
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-09-01T00:00:00.000Z"),
    );
    expect(result.createdStores).toBe(2);
    expect(result.activatedStores).toBe(1);
    expect(result.activationRate).toBe(50);
  });

  it("exactly-24h boundary counts as activated (edge case)", async () => {
    const storeCreated = new Date("2026-08-05T00:00:00.000Z");
    const db = stubDb({
      store: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async () => [{ id: "s1", createdAt: storeCreated }]),
      },
      product: {
        findMany: vi.fn(async () => [
          { storeId: "s1", createdAt: new Date(storeCreated.getTime() + 24 * 3_600_000) },
        ]),
      },
    });
    const service = await serviceFor(db);
    const result = await service.getActivation(
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-09-01T00:00:00.000Z"),
    );
    expect(result.activatedStores).toBe(1);
  });
});

describe("AdminService.getLedgerAnomalies", () => {
  it("flags negative stock and ledger/quantity mismatches (happy path)", async () => {
    const db = stubDb({
      branchStock: { findMany: vi.fn(async () => []) },
      product: {
        findMany: vi.fn(async () => [
          {
            id: "p1",
            storeId: "s1",
            store: { name: "Store A" },
            name: "Broken",
            quantity: -3,
            stockLedgerEntries: [{ quantityChange: 4 }],
          },
          {
            id: "p2",
            storeId: "s2",
            store: { name: "Store B" },
            name: "Mismatched",
            quantity: 5,
            stockLedgerEntries: [{ quantityChange: 10 }],
          },
          {
            id: "p3",
            storeId: "s3",
            store: { name: "Store C" },
            name: "Clean",
            quantity: 10,
            stockLedgerEntries: [{ quantityChange: 10 }],
          },
        ]),
      },
    });
    const service = await serviceFor(db);
    const result = await service.getLedgerAnomalies();
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ issue: "NEGATIVE_STOCK", quantity: -3 });
    expect(result.items[1]).toMatchObject({ issue: "LEDGER_MISMATCH", ledgerTotal: 10 });
  });
});

describe("AdminService.getOrphanedOrders", () => {
  it("returns PENDING orders older than the window with the window echoed (happy path)", async () => {
    const cutoff = new Date(Date.now() - 24 * 3_600_000);
    const db = stubDb({
      order: {
        findMany: vi.fn(async () => [
          {
            id: "o1",
            storeId: "s1",
            store: { name: "Store A" },
            status: "PENDING",
            paymentReference: "ref-1",
            createdAt: new Date(cutoff.getTime() - 1_000),
          },
        ]),
      },
    });
    const service = await serviceFor(db);
    const result = await service.getOrphanedOrders(24);
    expect(result.windowHours).toBe(24);
    expect(result.items).toHaveLength(1);
    expect(db.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "PENDING" }) }),
    );
  });
});

describe("AdminService.searchStores", () => {
  it("maps rows to the search DTO with tier and subscription status (happy path)", async () => {
    const db = stubDb({
      store: {
        findMany: vi.fn(async () => [
          {
            id: "s1",
            name: "Ade's Corner",
            subdomain: "demo",
            businessType: "RETAIL",
            createdAt: new Date("2026-08-01T00:00:00.000Z"),
            owner: { account: { email: "owner@demo.com" } },
            subscription: { tier: "PRO", status: "ACTIVE" },
          },
          {
            id: "s2",
            name: "No Plan Shop",
            subdomain: null,
            businessType: "OTHER",
            createdAt: new Date("2026-08-02T00:00:00.000Z"),
            owner: { account: { email: "o2@demo.com" } },
            subscription: null,
          },
        ]),
      },
    });
    const service = await serviceFor(db);
    const result = await service.searchStores({ limit: 25 });
    expect(result.items[0]).toMatchObject({ tier: "PRO", subscriptionStatus: "ACTIVE" });
    expect(result.items[1]).toMatchObject({ tier: null, subscriptionStatus: null });
  });
});

describe("AdminService.rotateTwoFactor", () => {
  it("replaces the secret and returns it with an otpauth URL exactly once (happy path)", async () => {
    const db = stubDb({
      adminUser: { update: vi.fn(async (x: unknown) => x) },
      adminAuditLog: { create: vi.fn(async (x: unknown) => x) },
    });
    const service = await serviceFor(db);
    const rotated = await service.rotateTwoFactor("admin-uuid-1", "admin@brikoh.dev");
    expect(rotated.secret).toMatch(/^[A-Z2-7]+={0,3}$/);
    expect(rotated.otpauthUrl).toContain(rotated.secret);
    expect(db.adminAuditLog.create).toHaveBeenCalledOnce();
  });
});

describe("AdminService.login 2FA gate", () => {
  it("never signs a token without a verified TOTP (security invariant)", async () => {
    const row = adminRow("admin@brikoh.dev", "SUPER_ADMIN");
    const db = stubDb({
      adminUser: { findUnique: vi.fn(async () => row) },
      adminAuditLog: { create: vi.fn(async (x: unknown) => x) },
    });
    const service = await serviceFor(db);
    await expect(service.login(row.email, "wrong", "123456")).rejects.toBeInstanceOf(AppError);
    // No audit row, no token — nothing observable happened.
    expect(db.adminAuditLog?.create).not.toHaveBeenCalled();
  });
});
