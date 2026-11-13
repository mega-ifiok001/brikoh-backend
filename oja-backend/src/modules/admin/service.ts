import bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient, type $Enums } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { adminRefreshTokenLifetimeMs, signAdminAccessToken } from "../../lib/adminTokens.js";
import {
  formatRefreshToken,
  generateRefreshTokenSecret,
  parseRefreshToken,
} from "../../lib/tokens.js";
import { getPrismaClient } from "../../lib/prisma.js";
import {
  ACTIVATION_WINDOW_MS,
  CHURNED_STATUSES,
  computeActivationRate,
  computeChurnRate,
  countEventsByUtcBucket,
} from "../analytics/lifecycle.js";
import type { Granularity } from "../analytics/constants.js";
import { reprocessWebhookEvent } from "../webhooks/service.js";
import { AUDIT_ACTIONS, writeAuditLog } from "./audit.js";
import { buildTotpOtpauthUrl, generateTotpSecret, verifyTotpToken } from "./totp.js";
import { computeFunnel, medianFirstOrderSeconds } from "./telemetry.js";

/**
 * ============================================================
 * ADMIN SERVICE
 * ============================================================
 *
 * Every admin Prisma read/write lives in this class — controllers stay
 * thin. Admin routes are NEVER resolveTenant-scoped; cross-store actions
 * are recorded via writeAuditLog at record granularity. Where a merchant
 * service already owns a write (webhook fulfillment), this service calls
 * it instead of reimplementing the business rule (see reprocessWebhook).
 *
 * The Prisma handle is injected through the constructor (defaulting to
 * the shared client) so unit tests substitute a stub without module
 * mocking.
 * ============================================================
 */

export type AdminDb = Pick<
  PrismaClient,
  | "adminUser"
  | "adminRefreshToken"
  | "rolePermission"
  | "adminAuditLog"
  | "subscriptionPlanSetting"
  | "subscription"
  | "store"
  | "product"
  | "branchStock"
  | "order"
  | "staffMember"
  | "paymentCredential"
  | "webhookEvent"
>;

export interface AdminAuthContext {
  adminUserId: string;
  email: string;
  roleName: string;
  isActive: boolean;
  permissions: string[];
}

export interface AdminSession {
  accessToken: string;
  refreshToken: string;
  admin: { id: string; email: string; roleName: string };
}

export interface AdminSessionContext {
  ipAddress: string | null;
  userAgent: string | null;
}

const SUPER_ADMIN_ROLE = "SUPER_ADMIN";

export interface AuditLogItem {
  id: string;
  adminUserId: string;
  adminEmail: string | null;
  action: string;
  storeId: string | null;
  detail: Prisma.InputJsonValue | null;
  createdAt: string;
}

export interface SubscriptionHealth {
  byStatus: { status: $Enums.SubscriptionStatus; count: number }[];
  byTier: { tier: string; count: number; monthlyPrice: number | null }[];
  metrics: { activeSubscriptions: number; mrr: string };
  computedAt: string;
}

export class AdminService {
  constructor(private readonly db: AdminDb = getPrismaClient() as AdminDb) {}

  /**
   * Platform-staff login: email + password + a CURRENT TOTP code, all in
   * one request. There is no admin session without verified 2FA. The
   * credential failure (401 INVALID_CREDENTIALS) is deliberately
   * indistinguishable from an unknown email; a bad TOTP is surfaced
   * separately (401 2FA_INVALID) so the dashboard can render the step
   * that failed.
   */
  async login(
    email: string,
    password: string,
    totpToken: string,
    sessionContext: AdminSessionContext = { ipAddress: null, userAgent: null },
  ): Promise<AdminSession> {
    const row = await this.db.adminUser.findUnique({
      where: { email },
      include: { role: { select: { name: true } } },
    });
    if (row === null || !bcrypt.compareSync(password, row.passwordHash)) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }
    if (!verifyTotpToken(row.twoFactorSecret, totpToken)) {
      throw new AppError(401, "2FA_INVALID", "Invalid or expired 2FA code");
    }
    if (!row.isActive) {
      throw new AppError(403, "ACCOUNT_DISABLED", "This admin account is deactivated");
    }

    const accessToken = signAdminAccessToken({ sub: row.id, role: row.role.name });
    await writeAuditLog(this.db, {
      adminUserId: row.id,
      action: AUDIT_ACTIONS.LOGIN,
      detail: { email: row.email },
    });
    const { token: refreshToken } = await this.issueAdminRefreshToken(row.id, sessionContext);
    return {
      accessToken,
      refreshToken,
      admin: { id: row.id, email: row.email, roleName: row.role.name },
    };
  }

  /**
   * Mints a single opaque, rotating admin refresh token (rt_…) and persists
   * its id + family. The secret half is never stored — only the id is, so a
   * DB leak yields unusable tokens. Each issuance starts a new family; the
   * prior token is revoked on use (see refreshAdmin), and replay of a revoked
   * token revokes the whole family (theft response).
   */
  private async issueAdminRefreshToken(
    adminId: string,
    sessionContext: AdminSessionContext,
  ): Promise<{ token: string }> {
    const family = randomBytes(18).toString("base64url");
    const tokenId = randomBytes(18).toString("base64url");
    const secret = generateRefreshTokenSecret();
    const token = formatRefreshToken(tokenId, secret);
    const expiresAt = new Date(Date.now() + adminRefreshTokenLifetimeMs());
    await this.db.adminRefreshToken.create({
      data: { adminId, tokenId, family, expiresAt, ...sessionContext },
    });
    return { token };
  }

  /** Revokes every refresh token in a family (reuse-theft response). */
  private async revokeFamily(family: string): Promise<void> {
    await this.db.adminRefreshToken.updateMany({
      where: { family, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Revokes ALL of an admin's refresh tokens — used when the credential
   * itself changes (2FA rotate/reset), so a leaked refresh token can't
   * outlive the new secret. Forces a fresh login with the new TOTP.
   */
  async revokeAllAdminRefreshTokens(adminId: string): Promise<void> {
    await this.db.adminRefreshToken.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Rotates an admin refresh token into a fresh access + refresh pair.
   * A malformed/unknown token is 401 INVALID_REFRESH_TOKEN; an expired one
   * is 401 SESSION_EXPIRED; a replayed (already-revoked) token is treated
   * as theft → the whole family is revoked and 401 TOKEN_REUSE_DETECTED.
   * On success the presented token is revoked and a new family issued.
   */
  async refreshAdmin(
    refreshToken: string,
    sessionContext: AdminSessionContext = { ipAddress: null, userAgent: null },
  ): Promise<AdminSession> {
    const parsed = parseRefreshToken(refreshToken);
    if (parsed === null) {
      throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token is malformed");
    }
    const record = await this.db.adminRefreshToken.findUnique({
      where: { tokenId: parsed.tokenId },
    });
    if (record === null) {
      throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token not recognized");
    }
    if (record.revokedAt !== null) {
      await this.revokeFamily(record.family);
      throw new AppError(
        401,
        "TOKEN_REUSE_DETECTED",
        "Refresh token reuse detected — all admin sessions revoked",
      );
    }
    if (record.expiresAt.getTime() < Date.now()) {
      throw new AppError(401, "SESSION_EXPIRED", "Admin session expired — please sign in again");
    }
    await this.db.adminRefreshToken.update({
      where: { tokenId: parsed.tokenId },
      data: { revokedAt: new Date() },
    });
    const admin = await this.db.adminUser.findUnique({
      where: { id: record.adminId },
      include: { role: { select: { name: true } } },
    });
    if (admin === null || !admin.isActive) {
      throw new AppError(401, "UNAUTHORIZED", "Admin account not found or deactivated");
    }
    const { token: newRefreshToken } = await this.issueAdminRefreshToken(admin.id, sessionContext);
    return {
      accessToken: signAdminAccessToken({ sub: admin.id, role: admin.role.name }),
      refreshToken: newRefreshToken,
      admin: { id: admin.id, email: admin.email, roleName: admin.role.name },
    };
  }

  /**
   * Logs an admin out by revoking the presented refresh token's family.
   * Idempotent: a malformed, unknown, or already-revoked token is treated
   * as already logged out (no error).
   */
  async logoutAdmin(refreshToken: string): Promise<void> {
    const parsed = parseRefreshToken(refreshToken);
    if (parsed === null) return;
    const record = await this.db.adminRefreshToken.findUnique({
      where: { tokenId: parsed.tokenId },
    });
    if (record === null || record.revokedAt !== null) return;
    await this.revokeFamily(record.family);
  }

  /**
   * Loads the admin's identity, role, and CURRENT permission keys from the
   * database — the authority for every admin route. Token claims are
   * convenience only; nothing is trusted from the token itself.
   */
  async getAuthContext(adminUserId: string): Promise<AdminAuthContext> {
    const row = await this.db.adminUser.findUnique({
      where: { id: adminUserId },
      include: { role: { select: { name: true } } },
    });
    if (row === null) {
      throw new AppError(401, "UNAUTHORIZED", "Admin account not found");
    }
    const bindings = await this.db.rolePermission.findMany({
      where: { roleId: row.roleId },
      include: { permission: { select: { key: true } } },
    });
    return {
      adminUserId: row.id,
      email: row.email,
      roleName: row.role.name,
      isActive: row.isActive,
      permissions: bindings.map((binding) => binding.permission.key),
    };
  }

  /** Profile payload for GET /api/admin/me. */
  async getMe(adminUserId: string): Promise<{
    id: string;
    email: string;
    roleName: string;
    permissions: string[];
  }> {
    const ctx = await this.getAuthContext(adminUserId);
    return {
      id: ctx.adminUserId,
      email: ctx.email,
      roleName: ctx.roleName,
      permissions: ctx.permissions,
    };
  }

  /**
   * Rotates the admin's own 2FA secret. The old secret stops working
   * immediately; the new one is returned exactly once with its otpauth
   * provisioning URL.
   */
  async rotateTwoFactor(
    adminUserId: string,
    email: string,
  ): Promise<{ secret: string; otpauthUrl: string }> {
    const secret = generateTotpSecret();
    await this.db.adminUser.update({
      where: { id: adminUserId },
      data: { twoFactorSecret: secret },
    });
    // The credential changed — every outstanding refresh token must die so a
    // leaked session can't survive the new secret.
    await this.revokeAllAdminRefreshTokens(adminUserId);
    await writeAuditLog(this.db, {
      adminUserId,
      action: AUDIT_ACTIONS.TWO_FACTOR_ROTATED,
      detail: { email },
    });
    return { secret, otpauthUrl: buildTotpOtpauthUrl(secret, email) };
  }

  /**
   * Break-glass: a SUPER_ADMIN force-rotates ANOTHER admin's 2FA secret to
   * recover a lost authenticator. This is strictly non-destructive — it
   * updates ONLY the target's `twoFactorSecret` and INSERTS one new
   * AdminAuditLog row. It never touches the append-only audit trail (which
   * the DB trigger also forbids mutating), nor the target's role,
   * permissions, isActive flag, or any other data. Existing JWTs keep
   * working until natural expiry; only future logins require the new code.
   */
  async resetTwoFactor(
    caller: { adminUserId: string; email: string; roleName: string },
    targetAdminUserId: string,
  ): Promise<{ email: string; secret: string; otpauthUrl: string }> {
    if (caller.roleName !== SUPER_ADMIN_ROLE) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only a SUPER_ADMIN may reset another admin's two-factor authentication",
      );
    }
    const target = await this.db.adminUser.findUnique({ where: { id: targetAdminUserId } });
    if (target === null) {
      throw new AppError(404, "NOT_FOUND", "No admin found with that id");
    }
    const secret = generateTotpSecret();
    await this.db.adminUser.update({
      where: { id: targetAdminUserId },
      data: { twoFactorSecret: secret },
    });
    // Break-glass also invalidates the target's sessions — they must re-auth
    // with the new secret (and the resetter's sessions are untouched).
    await this.revokeAllAdminRefreshTokens(targetAdminUserId);
    await writeAuditLog(this.db, {
      adminUserId: caller.adminUserId,
      action: AUDIT_ACTIONS.ADMIN_2FA_RESET,
      detail: { targetAdminId: target.id, targetEmail: target.email, resetBy: caller.email },
    });
    return { email: target.email, secret, otpauthUrl: buildTotpOtpauthUrl(secret, target.email) };
  }

  /**
   * Audit-log query. SUPER_ADMIN-only: granting the `audit:view`
   * permission is NOT sufficient — the role itself is checked here, so
   * the requirement holds even if role bindings drift.
   */
  async listAuditLog(
    caller: { adminUserId: string; roleName: string },
    query: {
      adminId?: string;
      storeId?: string;
      action?: string;
      start?: string;
      end?: string;
      cursor?: string;
      limit: number;
    },
  ): Promise<{ items: AuditLogItem[]; nextCursor: string | null }> {
    if (caller.roleName !== SUPER_ADMIN_ROLE) {
      throw new AppError(403, "FORBIDDEN", "Only SUPER_ADMIN may read the audit log");
    }
    const where: Prisma.AdminAuditLogWhereInput = {
      adminUserId: query.adminId,
      storeId: query.storeId,
      action: query.action,
      createdAt:
        query.start !== undefined || query.end !== undefined
          ? {
              ...(query.start !== undefined ? { gte: new Date(query.start) } : {}),
              ...(query.end !== undefined ? { lt: new Date(query.end) } : {}),
            }
          : undefined,
    };

    const rows = await this.db.adminAuditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor !== undefined ? { cursor: { id: query.cursor } } : {}),
    });

    const page = rows.slice(0, query.limit);
    const emails = await this.resolveAdminEmails(page.map((row) => row.adminUserId));
    return {
      items: page.map((row) => ({
        id: row.id,
        adminUserId: row.adminUserId,
        adminEmail: emails.get(row.adminUserId) ?? null,
        action: row.action,
        storeId: row.storeId,
        detail: row.detail,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  private async resolveAdminEmails(adminUserIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(adminUserIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.adminUser.findMany({
      where: { id: { in: unique } },
      select: { id: true, email: true },
    });
    return new Map(rows.map((row) => [row.id, row.email]));
  }

  /**
   * Merchant search for support: by name or owner email, with optional
   * active-subscription tier/status filters. Cursor-paginated, newest
   * stores first.
   */
  async searchStores(query: {
    q?: string;
    tier?: string;
    subscriptionStatus?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const where: Prisma.StoreWhereInput = {
      ...(query.q !== undefined
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" as const } },
              {
                owner: { account: { email: { contains: query.q, mode: "insensitive" as const } } },
              },
            ],
          }
        : {}),
      ...(query.tier !== undefined
        ? { subscription: { tier: query.tier.toUpperCase() as $Enums.SubscriptionTier } }
        : {}),
      ...(query.subscriptionStatus === "active"
        ? { subscription: { status: "ACTIVE" } }
        : query.subscriptionStatus === "inactive"
          ? { OR: [{ subscriptionId: null }, { subscription: { status: { not: "ACTIVE" } } }] }
          : {}),
    };

    const rows = await this.db.store.findMany({
      where,
      include: {
        subscription: { select: { tier: true, status: true } },
        owner: { include: { account: { select: { email: true } } } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor !== undefined ? { cursor: { id: query.cursor } } : {}),
    });

    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        name: row.name,
        subdomain: row.subdomain,
        businessType: row.businessType,
        ownerEmail: row.owner?.account.email ?? null,
        tier: row.subscription?.tier ?? null,
        subscriptionStatus: row.subscription?.status ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** Full support view of one store: plan, usage, staff, recent orders, webhook health. */
  async getStoreDetail(storeId: string): Promise<Record<string, unknown>> {
    const row = await this.db.store.findUnique({
      where: { id: storeId },
      include: {
        subscription: true,
        owner: { include: { account: { select: { email: true } } } },
        staffMembers: {
          include: { account: { select: { firstName: true, lastName: true } } },
        },
        orders: { orderBy: { createdAt: "desc" }, take: 10 },
        paymentCredentials: { select: { provider: true } },
        webhookEvents: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });
    if (row === null) {
      throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
    }

    const [products, orderCount] = await Promise.all([
      this.db.product.count({ where: { storeId, deletedAt: null } }),
      this.db.order.count({ where: { storeId } }),
    ]);

    const lastSuccess = row.webhookEvents.find((event) => event.status === "PROCESSED");
    const lastFailure = row.webhookEvents.find((event) => event.status === "FAILED");

    return {
      id: row.id,
      name: row.name,
      subdomain: row.subdomain,
      ownerEmail: row.owner?.account.email ?? null,
      businessType: row.businessType,
      createdAt: row.createdAt.toISOString(),
      plan: row.subscription
        ? {
            tier: row.subscription.tier,
            status: row.subscription.status,
            currentPeriodStart: row.subscription.currentPeriodStart?.toISOString() ?? null,
            currentPeriodEnd: row.subscription.currentPeriodEnd.toISOString(),
            usage: {
              staff: row.staffMembers.length,
              products,
              orders: orderCount,
            },
            activeSubscriptionId: row.subscription.id,
          }
        : null,
      staff: row.staffMembers.map((member) => ({
        id: member.id,
        role: member.role,
        permissions: member.permissions,
        name: [member.account.firstName, member.account.lastName].filter(Boolean).join(" ") || "—",
      })),
      recentOrders: row.orders.map((order) => ({
        id: order.id,
        status: order.status,
        total: order.total.toFixed(2),
        createdAt: order.createdAt.toISOString(),
      })),
      paymentProvider: {
        provider: row.paymentCredentials[0]?.provider ?? null,
        webhookHealth: {
          lastSuccessAt: lastSuccess?.processedAt?.toISOString() ?? null,
          lastFailureAt: lastFailure?.processedAt?.toISOString() ?? null,
          lastEvents: row.webhookEvents.map((event) => ({
            id: event.id,
            status: event.status.toLowerCase(),
            event: String((event.payload as { event?: unknown }).event ?? null),
            createdAt: event.createdAt.toISOString(),
          })),
        },
      },
    };
  }

  /** Store signups bucketed over UTC days/weeks (shared bucket helper). */
  async getSignups(
    start: Date,
    end: Date,
    granularity: Granularity,
  ): Promise<{
    range: { start: string; end: string };
    granularity: Granularity;
    buckets: unknown[];
  }> {
    const stores = await this.db.store.findMany({
      where: { createdAt: { gte: start, lt: end } },
      select: { createdAt: true },
    });
    return {
      range: { start: start.toISOString(), end: end.toISOString() },
      granularity,
      buckets: countEventsByUtcBucket(stores, start, end, granularity),
    };
  }

  /** Activation rate per the shared 24h published-product proxy. */
  async getActivation(
    start: Date,
    end: Date,
  ): Promise<{
    range: { start: string; end: string };
    createdStores: number;
    activatedStores: number;
    activationRate: number | null;
  }> {
    const stores = await this.db.store.findMany({
      where: { createdAt: { gte: start, lt: end } },
      select: { id: true, createdAt: true },
    });
    const storeIds = stores.map((store) => store.id);
    const products =
      storeIds.length > 0
        ? await this.db.product.findMany({
            where: { storeId: { in: storeIds }, deletedAt: null },
            select: { storeId: true, createdAt: true },
          })
        : [];

    const activatedStores = new Set<string>();
    for (const store of stores) {
      const windowEnd = store.createdAt.getTime() + ACTIVATION_WINDOW_MS;
      const published = products.some(
        (product) =>
          product.storeId === store.id &&
          product.createdAt.getTime() >= store.createdAt.getTime() &&
          product.createdAt.getTime() <= windowEnd,
      );
      if (published) activatedStores.add(store.id);
    }

    return {
      range: { start: start.toISOString(), end: end.toISOString() },
      createdStores: stores.length,
      activatedStores: activatedStores.size,
      activationRate: computeActivationRate(activatedStores.size, stores.length),
    };
  }

  /** Subscription status/tier breakdown plus MRR from the mutable pricing table. */
  async getSubscriptionHealth(): Promise<SubscriptionHealth> {
    const [byStatus, byTier, settings] = await Promise.all([
      this.db.subscription.groupBy({ by: ["status"], _count: true }),
      this.db.subscription.groupBy({ by: ["tier"], where: { status: "ACTIVE" }, _count: true }),
      this.db.subscriptionPlanSetting.findMany(),
    ]);

    const prices = new Map(settings.map((setting) => [setting.plan, setting.monthlyPrice]));
    const activeCounts = new Map(byTier.map((group) => [group.tier, group._count]));
    const mrr = [...prices.entries()].reduce((sum, [plan, price]) => {
      if (price === null || price === undefined) return sum;
      return sum.add(price.mul(activeCounts.get(plan) ?? 0));
    }, new Prisma.Decimal(0));

    // Every plan appears in byTier (zero-count included) so the dashboard
    // always renders the full pricing surface; prices come from the table.
    const byTierRows = [...prices.entries()]
      .map(([plan, price]) => ({
        tier: plan.toLowerCase(),
        count: activeCounts.get(plan) ?? 0,
        monthlyPrice: price === null ? null : price.toNumber(),
      }))
      .sort((a, b) => a.tier.localeCompare(b.tier));

    return {
      byStatus: byStatus
        .map((group) => ({ status: group.status, count: group._count }))
        .sort((a, b) => a.status.localeCompare(b.status)),
      byTier: byTierRows,
      metrics: {
        activeSubscriptions: byStatus.find((group) => group.status === "ACTIVE")?._count ?? 0,
        mrr: mrr.toFixed(2),
      },
      computedAt: new Date().toISOString(),
    };
  }

  /** Churn per the official shared definition (see analytics/lifecycle.ts). */
  async getChurn(
    start: Date,
    end: Date,
  ): Promise<{
    range: { start: string; end: string };
    activeAtPeriodStart: number;
    churned: number;
    churnRate: number | null;
  }> {
    const [activeRows, churnedRows] = await Promise.all([
      this.db.subscription.findMany({
        where: { status: "ACTIVE", createdAt: { lt: start } },
        select: { storeId: true },
      }),
      this.db.subscription.findMany({
        where: {
          status: { in: [...CHURNED_STATUSES] },
          createdAt: { lt: start },
          updatedAt: { gte: start, lt: end },
        },
        select: { storeId: true },
      }),
    ]);
    const activeAtPeriodStart = new Set(activeRows.map((row) => row.storeId)).size;
    const churned = new Set(churnedRows.map((row) => row.storeId)).size;
    return {
      range: { start: start.toISOString(), end: end.toISOString() },
      activeAtPeriodStart,
      churned,
      churnRate: computeChurnRate(churned, activeAtPeriodStart),
    };
  }

  /** Current monthly price for every plan (the MRR source of truth). */
  async listPricing(): Promise<{
    items: { plan: string; monthlyPrice: number | null; paystackPlanCode: string | null }[];
  }> {
    const rows = await this.db.subscriptionPlanSetting.findMany({ orderBy: { plan: "asc" } });
    return {
      items: rows.map((row) => ({
        plan: row.plan.toLowerCase(),
        monthlyPrice: row.monthlyPrice === null ? null : row.monthlyPrice.toNumber(),
        paystackPlanCode: row.paystackPlanCode ?? null,
      })),
    };
  }

  /**
   * Admin-mutable pricing: upserts a plan's monthly price and records the
   * change in the audit log. MRR endpoints read this table, so a change
   * takes effect immediately.
   */
  async updatePricing(
    plan: string,
    monthlyPrice: number | null,
    adminUserId: string,
    paystackPlanCode?: string | null,
  ): Promise<{ plan: string; monthlyPrice: number | null; updatedAt: string }> {
    const tier = plan.toUpperCase() as $Enums.SubscriptionTier;
    if (!["STARTER", "PRO", "ENTERPRISE"].includes(tier)) {
      throw new AppError(400, "INVALID_PLAN", `Unknown plan "${plan}"`);
    }
    const row = await this.db.subscriptionPlanSetting.upsert({
      where: { plan: tier },
      update: {
        monthlyPrice,
        ...(paystackPlanCode !== undefined ? { paystackPlanCode } : {}),
        updatedById: adminUserId,
      },
      create: {
        plan: tier,
        monthlyPrice,
        ...(paystackPlanCode !== undefined ? { paystackPlanCode } : {}),
        updatedById: adminUserId,
      },
    });
    await writeAuditLog(this.db, {
      adminUserId,
      action: AUDIT_ACTIONS.PRICING_UPDATED,
      detail: { plan: tier, monthlyPrice, paystackPlanCode: row.paystackPlanCode },
    });
    return {
      plan: row.plan.toLowerCase(),
      monthlyPrice: row.monthlyPrice === null ? null : row.monthlyPrice.toNumber(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Replays a stored webhook payload through the real fulfillment
   * pipeline (webhooks service) — never a direct DB edit. Guarded: only
   * events that were never PROCESSED can be replayed.
   */
  async reprocessWebhook(eventId: string, adminUserId: string): Promise<{ outcome: string }> {
    const result = await reprocessWebhookEvent(eventId);
    await writeAuditLog(this.db, {
      adminUserId,
      action: AUDIT_ACTIONS.WEBHOOK_REPROCESSED,
      detail: { eventId, outcome: result.outcome },
    });
    return { outcome: result.outcome };
  }

  /**
   * Ledger integrity: negative stock (should be impossible — defense in
   * depth against corruption/import bugs) and ledger-vs-quantity
   * reconciliation mismatches.
   */
  async getLedgerAnomalies(): Promise<{ items: unknown[] }> {
    const products = await this.db.product.findMany({
      where: { deletedAt: null },
      include: {
        store: { select: { name: true } },
        // Variant-ledger rows belong to ProductVariant.quantity, not the
        // product-level counter — excluding them keeps the product-level
        // reconciliation meaningful for variant-having products (whose
        // product.quantity stays 0 by design).
        stockLedgerEntries: {
          where: { variantId: null },
          select: { quantityChange: true },
        },
      },
    });

    const items: unknown[] = [];
    for (const product of products) {
      const ledgerTotal = product.stockLedgerEntries.reduce(
        (sum, entry) => sum + entry.quantityChange,
        0,
      );
      if (product.quantity < 0) {
        items.push({
          storeId: product.storeId,
          storeName: product.store.name,
          productId: product.id,
          productName: product.name,
          quantity: product.quantity,
          ledgerTotal: null,
          issue: "NEGATIVE_STOCK",
        });
      } else if (ledgerTotal !== product.quantity) {
        items.push({
          storeId: product.storeId,
          storeName: product.store.name,
          productId: product.id,
          productName: product.name,
          quantity: product.quantity,
          ledgerTotal,
          issue: "LEDGER_MISMATCH",
        });
      }
    }

    // Per-branch negative stock (should be impossible — the conditional
    // UPDATE guards every movement; this is defense against corruption
    // or manual tampering with the BranchStock rows).
    const branchStocks = await this.db.branchStock.findMany({
      where: { quantity: { lt: 0 } },
      include: {
        branch: { select: { name: true } },
        product: { select: { name: true } },
      },
    });
    for (const row of branchStocks) {
      items.push({
        storeId: row.storeId,
        branchId: row.branchId,
        branchName: row.branch.name,
        productId: row.productId,
        productName: row.product.name,
        variantId: row.variantId,
        quantity: row.quantity,
        issue: "NEGATIVE_BRANCH_STOCK",
      });
    }
    return { items };
  }

  /** Orders awaiting a payment confirmation longer than the window. */
  async getOrphanedOrders(hours: number): Promise<{ items: unknown[]; windowHours: number }> {
    const cutoff = new Date(Date.now() - hours * 3_600_000);
    const rows = await this.db.order.findMany({
      where: { status: "PENDING", createdAt: { lt: cutoff } },
      include: { store: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });
    return {
      windowHours: hours,
      items: rows.map((row) => ({
        orderId: row.id,
        storeId: row.storeId,
        storeName: row.store.name,
        status: row.status,
        paymentReference: row.paymentReference,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** Moderation review queue — placeholder shape until the pipeline exists. */
  async getModerationQueue(): Promise<{
    queue: unknown[];
    nextCursor: null;
    reviewPolicy: string;
  }> {
    return {
      queue: [],
      nextCursor: null,
      reviewPolicy: "no moderation pipeline wired yet — pending shape",
    };
  }

  /**
   * Platform financial rollup (SUPER_ADMIN only). Every number is computed
   * for real across all tenants: store count, subscription/order status
   * breakdowns, PAID revenue grouped by store currency (no FX blend), and
   * MRR from the mutable pricing table (ACTIVE subscriptions only, NGN).
   * Logs the read access (by contract every cross-tenant view is audited).
   */
  async getOverview(adminUserId: string): Promise<{
    totalStores: number;
    subscriptionsByStatus: Record<string, number>;
    orderCountsByStatus: Record<string, number>;
    revenueByCurrency: { currency: string; total: number }[];
    mrr: number;
    mrrCurrency: "NGN";
  }> {
    const [totalStores, subs, orders, paidOrders, settings] = await Promise.all([
      this.db.store.count(),
      this.db.subscription.groupBy({ by: ["status"], _count: true }),
      this.db.order.groupBy({ by: ["status"], _count: true }),
      this.db.order.findMany({
        where: { status: "PAID" },
        include: { store: { select: { currency: true } } },
      }),
      this.db.subscriptionPlanSetting.findMany(),
    ]);

    const subscriptionsByStatus = Object.fromEntries(
      (["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED"] as const).map((status) => [
        status,
        subs.find((group) => group.status === status)?._count ?? 0,
      ]),
    ) as Record<string, number>;

    const orderCountsByStatus = Object.fromEntries(
      (
        [
          "PENDING",
          "AWAITING_PAYMENT",
          "PAID",
          "SHIPPED",
          "CANCELLED",
          "REFUNDED",
          "FAILED",
        ] as const
      ).map((status) => [status, orders.find((group) => group.status === status)?._count ?? 0]),
    ) as Record<string, number>;

    const revenue = new Map<string, Prisma.Decimal>();
    for (const order of paidOrders) {
      const currency = order.store.currency;
      revenue.set(currency, (revenue.get(currency) ?? new Prisma.Decimal(0)).add(order.total));
    }
    const revenueByCurrency = [...revenue.entries()]
      .map(([currency, total]) => ({ currency, total: Number(total) }))
      .sort((a, b) => a.currency.localeCompare(b.currency));

    const prices = new Map(settings.map((setting) => [setting.plan, setting.monthlyPrice]));
    const activeSubscriptions = await this.db.subscription.findMany({
      where: { status: "ACTIVE" },
      select: { tier: true },
    });
    const mrr = activeSubscriptions.reduce((sum, sub) => {
      const price = prices.get(sub.tier);
      if (price === null || price === undefined) return sum;
      return sum.add(price);
    }, new Prisma.Decimal(0));

    await writeAuditLog(this.db, {
      adminUserId,
      action: AUDIT_ACTIONS.OVERVIEW_VIEWED,
      detail: {},
    });

    return {
      totalStores,
      subscriptionsByStatus,
      orderCountsByStatus,
      revenueByCurrency,
      mrr: Number(mrr),
      mrrCurrency: "NGN",
    };
  }

  /**
   * One row per Store with its Owner and a trailing-30-day GMV.
   * Cursor-paginated. Logs the read access with the filters used.
   */
  async listMerchants(
    adminUserId: string,
    query: {
      q?: string;
      cursor?: string;
      limit: number;
    },
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const where: Prisma.StoreWhereInput =
      query.q !== undefined
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" as const } },
              {
                owner: {
                  account: { email: { contains: query.q, mode: "insensitive" as const } },
                },
              },
            ],
          }
        : {};

    const rows = await this.db.store.findMany({
      where,
      include: {
        owner: {
          include: { account: { select: { firstName: true, lastName: true, email: true } } },
        },
        subscription: { select: { tier: true, status: true } },
        orders: {
          where: { status: "PAID", createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
          select: { total: true },
        },
        _count: { select: { orders: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor !== undefined ? { cursor: { id: query.cursor } } : {}),
    });

    const page = rows.slice(0, query.limit);
    const items = page.map((row) => {
      const ownerName =
        [row.owner?.account.firstName, row.owner?.account.lastName].filter(Boolean).join(" ") ||
        "—";
      const gmv = row.orders.reduce((sum, order) => sum + Number(order.total), 0);
      return {
        id: row.id,
        storeName: row.name,
        ownerName,
        ownerEmail: row.owner?.account.email ?? null,
        tier: row.subscription?.tier.toLowerCase() ?? null,
        subscriptionStatus: row.subscription?.status ?? null,
        gmvLast30d: gmv,
        gmvCurrency: row.currency,
        orderCount: row._count.orders,
        createdAt: row.createdAt.toISOString(),
      };
    });

    await writeAuditLog(this.db, {
      adminUserId,
      action: AUDIT_ACTIONS.MERCHANTS_VIEWED,
      detail: { q: query.q ?? null, limit: query.limit, cursor: query.cursor ?? null },
    });

    return {
      items,
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Store fleet view: tier, status, live product count vs cap.
   * Cursor-paginated. Logs the read access with the filters used.
   */
  async listStoresFleet(
    adminUserId: string,
    query: {
      q?: string;
      cursor?: string;
      limit: number;
    },
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const where: Prisma.StoreWhereInput =
      query.q !== undefined
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" as const } },
              { subdomain: { contains: query.q, mode: "insensitive" as const } },
              { customDomain: { contains: query.q, mode: "insensitive" as const } },
            ],
          }
        : {};

    const rows = await this.db.store.findMany({
      where,
      include: {
        subscription: { select: { tier: true, status: true, productCap: true } },
        _count: { select: { products: { where: { deletedAt: null } } } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor !== undefined ? { cursor: { id: query.cursor } } : {}),
    });

    const page = rows.slice(0, query.limit);
    const items = page.map((row) => ({
      id: row.id,
      name: row.name,
      subdomain: row.subdomain,
      customDomain: row.customDomain,
      currency: row.currency,
      tier: row.subscription?.tier.toLowerCase() ?? null,
      subscriptionStatus: row.subscription?.status ?? null,
      productCount: row._count.products,
      productCap: row.subscription?.productCap ?? null,
      status: row.subscription?.status ?? "NO_SUBSCRIPTION",
      createdAt: row.createdAt.toISOString(),
    }));

    await writeAuditLog(this.db, {
      adminUserId,
      action: AUDIT_ACTIONS.STORES_VIEWED,
      detail: { q: query.q ?? null, limit: query.limit, cursor: query.cursor ?? null },
    });

    return {
      items,
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Cross-tenant order log. Cursor-paginated, newest first. Optional
   * status filter + orderNumber search. Logs the read access with the
   * filters used.
   */
  async listOrders(
    adminUserId: string,
    query: {
      status?: string;
      q?: string;
      cursor?: string;
      limit: number;
    },
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const where: Prisma.OrderWhereInput = {
      ...(query.status !== undefined ? { status: query.status as $Enums.OrderStatus } : {}),
      ...(query.q !== undefined
        ? { orderNumber: { contains: query.q, mode: "insensitive" as const } }
        : {}),
    };

    const rows = await this.db.order.findMany({
      where,
      include: {
        store: { select: { name: true, currency: true } },
        customer: { select: { name: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor !== undefined ? { cursor: { id: query.cursor } } : {}),
    });

    const page = rows.slice(0, query.limit);
    const items = page.map((row) => ({
      id: row.id,
      orderNumber: row.orderNumber,
      storeId: row.storeId,
      storeName: row.store?.name ?? null,
      customerName: row.customer?.name ?? "—",
      total: Number(row.total),
      currency: row.store?.currency ?? "NGN",
      status: row.status,
      paymentMethod: row.paymentMethod ?? null,
      paymentProvider: row.paymentProvider ?? null,
      source: row.source,
      createdAt: row.createdAt.toISOString(),
    }));

    await writeAuditLog(this.db, {
      adminUserId,
      action: AUDIT_ACTIONS.ORDERS_VIEWED,
      detail: {
        status: query.status ?? null,
        q: query.q ?? null,
        limit: query.limit,
        cursor: query.cursor ?? null,
      },
    });

    return {
      items,
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async getTelemetryFunnel(adminUserId: string, start: Date, end: Date) {
    const stores = await this.db.store.findMany({
      where: { createdAt: { gte: start, lt: end } },
      select: {
        createdAt: true,
        products: {
          where: { status: "PUBLISHED" },
          select: { updatedAt: true },
          orderBy: { updatedAt: "asc" },
          take: 1,
        },
        orders: { select: { createdAt: true, paidAt: true }, orderBy: { createdAt: "asc" } },
        subscriptionHistory: {
          select: { tier: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    const rows = stores.map((store) => {
      const firstOrder = store.orders[0] ?? null;
      const paidAt =
        store.orders
          .filter((order) => order.paidAt !== null)
          .sort((a, b) => a.paidAt!.getTime() - b.paidAt!.getTime())[0]?.paidAt ?? null;
      const firstPaidTier = store.subscriptionHistory.find(
        (subscription, index) =>
          subscription.tier !== "STARTER" &&
          store.subscriptionHistory.slice(0, index).some((prior) => prior.tier === "STARTER"),
      );
      return {
        createdAt: store.createdAt,
        publishedAt: store.products[0]?.updatedAt ?? null,
        orderedAt: firstOrder?.createdAt ?? null,
        paidAt,
        upgradedAt: firstPaidTier?.createdAt ?? null,
      };
    });
    await writeAuditLog(this.db, {
      adminUserId,
      action: AUDIT_ACTIONS.TELEMETRY_FUNNEL_VIEWED,
      detail: { start: start.toISOString(), end: end.toISOString() },
    });
    return {
      range: { start: start.toISOString(), end: end.toISOString() },
      steps: computeFunnel(rows),
    };
  }

  async getMedianTimeToFirstOrder(adminUserId: string, start: Date, end: Date) {
    const stores = await this.db.store.findMany({
      where: { createdAt: { gte: start, lt: end } },
      select: {
        createdAt: true,
        orders: { select: { createdAt: true }, orderBy: { createdAt: "asc" }, take: 1 },
      },
    });
    const durations = stores.flatMap((store) => {
      const first = store.orders[0];
      if (!first) return [];
      const seconds = (first.createdAt.getTime() - store.createdAt.getTime()) / 1000;
      return seconds >= 0 ? [seconds] : [];
    });
    await writeAuditLog(this.db, {
      adminUserId,
      action: AUDIT_ACTIONS.TELEMETRY_MEDIAN_FIRST_ORDER_VIEWED,
      detail: { start: start.toISOString(), end: end.toISOString() },
    });
    return {
      range: { start: start.toISOString(), end: end.toISOString() },
      cohortStoreCount: stores.length,
      storesWithFirstOrder: durations.length,
      medianSeconds: medianFirstOrderSeconds(durations),
    };
  }

  async listAwaitingPaymentOrders(adminUserId: string, now: Date = new Date()) {
    const rows = await this.db.order.findMany({
      where: { status: "AWAITING_PAYMENT" },
      select: {
        id: true,
        orderNumber: true,
        total: true,
        paymentSubmittedAt: true,
        store: { select: { id: true, name: true, currency: true } },
      },
      orderBy: [{ paymentSubmittedAt: "asc" }, { id: "asc" }],
    });
    const items = rows
      .sort((a, b) => {
        if (a.paymentSubmittedAt === null) return b.paymentSubmittedAt === null ? 0 : 1;
        if (b.paymentSubmittedAt === null) return -1;
        return a.paymentSubmittedAt.getTime() - b.paymentSubmittedAt.getTime();
      })
      .map((order) => ({
        orderId: order.id,
        orderNumber: order.orderNumber,
        storeId: order.store.id,
        storeName: order.store.name,
        amount: order.total.toFixed(2),
        currency: order.store.currency,
        paymentSubmittedAt: order.paymentSubmittedAt?.toISOString() ?? null,
        waitingSeconds:
          order.paymentSubmittedAt === null
            ? null
            : Math.max(0, Math.floor((now.getTime() - order.paymentSubmittedAt.getTime()) / 1000)),
      }));
    await writeAuditLog(this.db, {
      adminUserId,
      action: AUDIT_ACTIONS.AWAITING_PAYMENT_ORDERS_VIEWED,
      detail: { count: items.length },
    });
    return { items };
  }

  async listAdminStaff(adminUserId: string, now: Date = new Date()) {
    const rows = await this.db.adminUser.findMany({
      include: {
        role: { select: { name: true } },
        refreshTokens: {
          where: { revokedAt: null, expiresAt: { gt: now } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { ipAddress: true, userAgent: true, createdAt: true },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const items = rows.map((row) => {
      const session = row.refreshTokens[0] ?? null;
      return {
        id: row.id,
        email: row.email,
        roleName: row.role.name,
        isActive: row.isActive,
        createdAt: row.createdAt.toISOString(),
        session:
          session === null
            ? null
            : {
                ipAddress: session.ipAddress,
                userAgent: session.userAgent,
                createdAt: session.createdAt.toISOString(),
              },
      };
    });
    await writeAuditLog(this.db, {
      adminUserId,
      action: AUDIT_ACTIONS.ADMIN_STAFF_VIEWED,
      detail: { count: items.length },
    });
    return { items };
  }
}
