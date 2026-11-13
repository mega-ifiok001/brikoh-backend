import { beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../lib/prisma.js";

/**
 * The AdminAuditLog table is append-only: inserts allowed, UPDATE/DELETE
 * rejected by a database trigger (the exact StockLedgerEntry discipline).
 * These tests drive the real trigger on the test database — the audit
 * trail must be impossible to rewrite at the storage layer, not just in
 * the service.
 */

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

async function uniqueRole() {
  return prisma.role.create({ data: { name: `TEST_AUDIT_${crypto.randomUUID()}` } });
}

/** Returns the audit row id. Created via the real FK graph. */
async function createAuditRow(roleId: string) {
  const admin = await prisma.adminUser.create({
    data: {
      email: `audit-${crypto.randomUUID()}@example.com`,
      passwordHash: "hashed",
      twoFactorSecret: "JBSWY3DPEHPK3PXP",
      roleId,
    },
  });
  const log = await prisma.adminAuditLog.create({
    data: { adminUserId: admin.id, action: "test.probe", detail: { probe: true } },
  });
  return { admin, log };
}

describe("AdminAuditLog append-only (DB trigger)", () => {
  let roleId: string;

  beforeEach(async () => {
    roleId = (await uniqueRole()).id;
  });

  it("accepts inserts (happy path)", async () => {
    const { log } = await createAuditRow(roleId);
    expect(log.action).toBe("test.probe");
  });

  it("rejects UPDATE of an audit row (sad path)", async () => {
    const { log } = await createAuditRow(roleId);
    await expect(
      prisma.adminAuditLog.update({
        where: { id: log.id },
        data: { action: "test.tampered" },
      }),
    ).rejects.toThrow(/required but not found|append-only/i);
  });

  it("rejects DELETE of an audit row (sad path)", async () => {
    const { log } = await createAuditRow(roleId);
    await expect(prisma.adminAuditLog.delete({ where: { id: log.id } })).rejects.toThrow(
      /required but not found|append-only/i,
    );
  });
});
