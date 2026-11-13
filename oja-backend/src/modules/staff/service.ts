import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { revokeAllRefreshTokens } from "../auth/service.js";
import { logStoreActivity } from "../activity/service.js";
import { updateStaffSchema, validateOrThrow, type UpdateStaffInput } from "./schemas.js";

export interface StaffListItem {
  id: string;
  email: string;
  role: string;
  permissions: string[];
  isActive: boolean;
  createdAt: Date;
}

export interface StaffUpdateResult {
  id: string;
  email: string;
  role: string;
  permissions: string[];
  isActive: boolean;
  updatedAt: Date;
}

export async function listStaff(storeId: string): Promise<{ items: StaffListItem[] }> {
  const rows = await getPrismaClient().staffMember.findMany({
    where: { storeId },
    include: { account: { select: { email: true } } },
    orderBy: { createdAt: "asc" },
  });

  return {
    items: rows.map((row) => ({
      id: row.id,
      email: row.account.email,
      role: row.role,
      permissions: row.permissions,
      isActive: row.isActive,
      createdAt: row.createdAt,
    })),
  };
}

/**
 * Updates a staff member's role and/or permission flags. Both fields are
 * optional but at least one must be present (enforced by the schema).
 * storeId scopes the lookup so a request can never address another
 * tenant's staff row.
 */
export async function updateStaffMember(
  storeId: string,
  staffId: string,
  input: unknown,
): Promise<StaffUpdateResult> {
  const data = validateOrThrow(updateStaffSchema, input) as UpdateStaffInput;
  const prisma = getPrismaClient();

  const existing = await prisma.staffMember.findFirst({ where: { id: staffId, storeId } });
  if (existing === null) {
    throw new AppError(404, "STAFF_NOT_FOUND", "This staff member no longer exists");
  }

  const updated = await prisma.staffMember.update({
    where: { id: staffId },
    data: {
      ...(data.role !== undefined ? { role: data.role } : {}),
      ...(data.permissions !== undefined ? { permissions: data.permissions } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
    include: { account: { select: { email: true } } },
  });

  // Role changes are recorded in the activity log (permission-flag-only
  // changes are not — they are routine configuration, not trust changes).
  if (data.role !== undefined && data.role !== existing.role) {
    await logStoreActivity(prisma, {
      storeId,
      action: "staff.role.updated",
      detail: {
        staffMemberId: staffId,
        email: updated.account.email,
        from: existing.role,
        to: data.role,
      },
    });
  }

  // Deactivation is a trust change: the member's sessions die now.
  // Reactivation restores login without touching role/permissions.
  if (data.isActive !== undefined && data.isActive !== existing.isActive) {
    await logStoreActivity(prisma, {
      storeId,
      action: data.isActive ? "staff.activated" : "staff.deactivated",
      detail: {
        staffMemberId: staffId,
        email: updated.account.email,
      },
    });
    if (!data.isActive) {
      await revokeAllRefreshTokens(existing.accountId);
    }
  }

  return {
    id: updated.id,
    email: updated.account.email,
    role: updated.role,
    permissions: updated.permissions,
    isActive: updated.isActive,
    updatedAt: updated.updatedAt,
  };
}

/**
 * Removes a staff member and revokes every active refresh token of their
 * account, so the removed member's sessions die with the access-token
 * lifetime instead of surviving via refresh rotation. The account itself
 * is untouched; ledger entries keep their history (performedByStaffId
 * becomes null via onDelete SetNull).
 */
export async function removeStaffMember(storeId: string, staffId: string): Promise<void> {
  const prisma = getPrismaClient();

  const existing = await prisma.staffMember.findFirst({
    where: { id: staffId, storeId },
    include: { account: { select: { email: true } } },
  });
  if (existing === null) {
    throw new AppError(404, "STAFF_NOT_FOUND", "This staff member no longer exists");
  }

  await revokeAllRefreshTokens(existing.accountId);
  await prisma.staffMember.delete({ where: { id: staffId } });
  await logStoreActivity(prisma, {
    storeId,
    action: "staff.removed",
    detail: { staffMemberId: staffId, email: existing.account.email },
  });
}
