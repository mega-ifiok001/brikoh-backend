import type { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import { toDiscountSummary, type DiscountSummary } from "../discounts/service.js";
import {
  customerGroupCreateSchema,
  customerGroupUpdateSchema,
  type CustomerGroupCreateInput,
  type CustomerGroupUpdateInput,
} from "./schemas.js";

/**
 * ============================================================
 * CUSTOMER GROUPS SERVICE
 * ============================================================
 * Merchant-defined segments of the address book. A group is a label with
 * an optional auto-applied discount; every store has an implicit
 * "General" group created lazily (like the Walk-in Customer row) that
 * new customers without an explicit group land in.
 *
 * Deleting a group with assigned customers is refused (409) — reassign
 * the members first. The DB itself never destroys customers (SetNull),
 * the refusal is a product rule.
 * ============================================================
 */

/** Name of the implicit per-store group new customers land in. */
export const DEFAULT_GROUP_NAME = "General";

export interface GroupSummary {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  discount: DiscountSummary | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupMemberRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  createdAt: Date;
}

export interface GroupDetail {
  group: GroupSummary;
  members: GroupMemberRow[];
}

/** True when a Prisma P2002 unique-violation targets the given column. */
function isUniqueViolation(err: unknown, field: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, meta } = err as { code?: unknown; meta?: unknown };
  if (code !== "P2002") return false;

  const candidates: string[] = [];
  const rawMeta = meta as {
    target?: unknown;
    driverAdapterError?: { cause?: { constraint?: unknown } };
  };
  const target = rawMeta.target;
  if (Array.isArray(target)) {
    candidates.push(...target.map(String));
  } else if (typeof target === "string" || typeof target === "object") {
    const column =
      typeof target === "object" && target !== null && "column" in target
        ? (target as { column?: unknown }).column
        : target;
    if (typeof column === "string") candidates.push(column);
  }
  const constraint = rawMeta.driverAdapterError?.cause?.constraint;
  if (typeof constraint === "string") {
    candidates.push(constraint);
  } else if (typeof constraint === "object" && constraint !== null) {
    const fields = (constraint as { fields?: unknown }).fields;
    if (Array.isArray(fields)) candidates.push(...fields.map(String));
  }

  return candidates.includes(field) || candidates.some((c) => c.endsWith(`_${field}_key`));
}

const groupSelect = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  discount: { select: { id: true, name: true, type: true, value: true } },
  _count: { select: { customers: true } },
} as const;

type GroupRowWithRelations = {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  discount: {
    id: string;
    name: string;
    type: "PERCENTAGE" | "FIXED";
    value: Prisma.Decimal;
  } | null;
  _count: { customers: number };
};

function toGroupSummary(row: GroupRowWithRelations): GroupSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    memberCount: row._count.customers,
    discount: row.discount === null ? null : toDiscountSummary(row.discount),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Finds the store's default "General" group, creating it on first use.
 * Concurrency-safe: a unique-constraint race falls back to a re-read.
 * Used by customer creation paths so new customers always land in a
 * group (dashboard-customer-groups.md).
 */
export async function ensureDefaultGroup(
  client: Pick<Prisma.TransactionClient, "customerGroup">,
  storeId: string,
): Promise<string> {
  const existing = await client.customerGroup.findFirst({
    where: { storeId, name: DEFAULT_GROUP_NAME },
    select: { id: true },
  });
  if (existing !== null) return existing.id;
  try {
    const created = await client.customerGroup.create({
      data: { storeId, name: DEFAULT_GROUP_NAME },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    if (isUniqueViolation(err, "name")) {
      const raced = await client.customerGroup.findFirst({
        where: { storeId, name: DEFAULT_GROUP_NAME },
        select: { id: true },
      });
      if (raced !== null) return raced.id;
    }
    throw err;
  }
}

/** Lists the store's groups with member counts, oldest first. */
export async function listCustomerGroups(storeId: string): Promise<GroupSummary[]> {
  const rows = await getPrismaClient().customerGroup.findMany({
    where: { storeId },
    orderBy: { createdAt: "asc" },
    select: groupSelect,
  });
  return rows.map(toGroupSummary);
}

/**
 * Creates a group. The attached discountId, when given, must belong to
 * the tenant (404 DISCOUNT_NOT_FOUND); a duplicate name is 409.
 */
export async function createCustomerGroup(
  storeId: string,
  staffMemberId: string | undefined,
  rawInput: unknown,
): Promise<GroupSummary> {
  const data = validateOrThrow(customerGroupCreateSchema, rawInput) as CustomerGroupCreateInput;
  const prisma = getPrismaClient();

  if (data.discountId !== undefined && data.discountId !== null) {
    await assertDiscountInStore(storeId, data.discountId);
  }

  let row: GroupRowWithRelations;
  try {
    row = await prisma.customerGroup.create({
      data: {
        storeId,
        name: data.name,
        description: data.description ?? null,
        discountId: data.discountId ?? null,
      },
      select: groupSelect,
    });
  } catch (err) {
    if (isUniqueViolation(err, "name")) {
      throw new AppError(409, "GROUP_NAME_TAKEN", "A group with this name already exists");
    }
    throw err;
  }
  await logStoreActivity(prisma, {
    storeId,
    staffMemberId: staffMemberId ?? null,
    action: "customerGroup.created",
    detail: { groupId: row.id, name: row.name },
  });
  return toGroupSummary(row);
}

/** One group with its members (up to 50 most recent). */
export async function getCustomerGroup(storeId: string, groupId: string): Promise<GroupDetail> {
  const prisma = getPrismaClient();
  const row = await prisma.customerGroup.findFirst({
    where: { id: groupId, storeId },
    select: groupSelect,
  });
  if (row === null) {
    throw new AppError(404, "CUSTOMER_GROUP_NOT_FOUND", "Customer group not found");
  }
  const members = await prisma.customer.findMany({
    where: { storeId, groupId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, name: true, phone: true, email: true, createdAt: true },
  });
  return { group: toGroupSummary(row), members };
}

/**
 * Updates only the provided fields. The conditional updateMany is the
 * authority: a zero-row match means unknown or cross-tenant (404). A
 * rename that collides with another group is 409; an attached discount
 * must belong to the tenant.
 */
export async function updateCustomerGroup(
  storeId: string,
  staffMemberId: string | undefined,
  groupId: string,
  rawInput: unknown,
): Promise<GroupSummary> {
  const data = validateOrThrow(customerGroupUpdateSchema, rawInput) as CustomerGroupUpdateInput;
  const prisma = getPrismaClient();

  if (data.discountId !== undefined && data.discountId !== null) {
    await assertDiscountInStore(storeId, data.discountId);
  }

  let updated: { count: number };
  try {
    updated = await prisma.customerGroup.updateMany({
      where: { id: groupId, storeId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.discountId !== undefined ? { discountId: data.discountId } : {}),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err, "name")) {
      throw new AppError(409, "GROUP_NAME_TAKEN", "A group with this name already exists");
    }
    throw err;
  }
  if (updated.count === 0) {
    throw new AppError(404, "CUSTOMER_GROUP_NOT_FOUND", "Customer group not found");
  }
  const row = await prisma.customerGroup.findFirstOrThrow({
    where: { id: groupId },
    select: groupSelect,
  });
  await logStoreActivity(prisma, {
    storeId,
    staffMemberId: staffMemberId ?? null,
    action: "customerGroup.updated",
    detail: { groupId, updatedFields: Object.keys(data) },
  });
  return toGroupSummary(row);
}

/**
 * Deletes a group. A group with any assigned customers is refused with
 * 409 GROUP_HAS_CUSTOMERS — reassign or delete the members first. The
 * conditional delete is the authority; zero-row match = 404.
 */
export async function deleteCustomerGroup(
  storeId: string,
  staffMemberId: string | undefined,
  groupId: string,
): Promise<void> {
  const prisma = getPrismaClient();
  const memberCount = await prisma.customer.count({ where: { storeId, groupId } });
  if (memberCount > 0) {
    throw new AppError(
      409,
      "GROUP_HAS_CUSTOMERS",
      "This group has assigned customers — reassign them before deleting the group",
    );
  }
  const deleted = await prisma.customerGroup.deleteMany({
    where: { id: groupId, storeId },
  });
  if (deleted.count === 0) {
    throw new AppError(404, "CUSTOMER_GROUP_NOT_FOUND", "Customer group not found");
  }
  await logStoreActivity(prisma, {
    storeId,
    staffMemberId: staffMemberId ?? null,
    action: "customerGroup.deleted",
    detail: { groupId },
  });
}

/** Verifies a discount belongs to the tenant; unknown/cross-tenant = 404. */
async function assertDiscountInStore(storeId: string, discountId: string): Promise<void> {
  const discount = await getPrismaClient().discount.findFirst({
    where: { id: discountId, storeId },
    select: { id: true },
  });
  if (discount === null) {
    throw new AppError(404, "DISCOUNT_NOT_FOUND", "Discount not found");
  }
}
