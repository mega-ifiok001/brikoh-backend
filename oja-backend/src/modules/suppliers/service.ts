import { Prisma } from "../../../generated/prisma/client.js";
import type { $Enums } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import {
  createSupplierSchema,
  updateSupplierSchema,
  type CreateSupplierInput,
  type UpdateSupplierInput,
} from "./schemas.js";

/**
 * ============================================================
 * SUPPLIERS SERVICE
 * ============================================================
 * The vendor directory. balanceDue is computed at read time (never
 * stored): the sum of total - amountPaid over the supplier's
 * non-draft, non-cancelled purchase orders. Deletion is ledger-safe —
 * the DB RESTRICT key backstops a 409 SUPPLIER_HAS_ORDERS; retiring a
 * supplier with history means isActive: false.
 */

/** Money-relevant purchase-order statuses (debt excludes DRAFT/CANCELLED). */
const DEBT_STATUSES: readonly $Enums.PurchaseOrderStatus[] = [
  "ORDERED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
];

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

export interface SupplierSummary {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  isActive: boolean;
  notes: string | null;
  purchaseOrderCount: number;
  balanceDue: string;
  createdAt: Date;
  updatedAt: Date;
}

interface SupplierRowShape {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  isActive: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { purchaseOrders: number };
}

function toSummary(row: SupplierRowShape, balanceDue: Prisma.Decimal): SupplierSummary {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    address: row.address,
    isActive: row.isActive,
    notes: row.notes,
    purchaseOrderCount: row._count?.purchaseOrders ?? 0,
    balanceDue: balanceDue.toFixed(2),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The supplier's outstanding money across its live orders. */
async function supplierBalanceDue(storeId: string, supplierId: string): Promise<Prisma.Decimal> {
  const rows = await getPrismaClient().purchaseOrder.findMany({
    where: { storeId, supplierId, status: { in: [...DEBT_STATUSES] } },
    select: { total: true, amountPaid: true },
  });
  return rows.reduce((sum, row) => sum.add(row.total.sub(row.amountPaid)), new Prisma.Decimal(0));
}

/** The full directory, ordered by name — no pagination (small lists). */
export async function listSuppliers(storeId: string): Promise<SupplierSummary[]> {
  const prisma = getPrismaClient();
  const rows = await prisma.supplier.findMany({
    where: { storeId },
    orderBy: { name: "asc" },
    include: { _count: { select: { purchaseOrders: true } } },
  });
  const balances = await prisma.purchaseOrder.groupBy({
    by: ["supplierId"],
    where: { storeId, status: { in: [...DEBT_STATUSES] } },
    _sum: { total: true, amountPaid: true },
  });
  const balanceMap = new Map(
    balances.map((row) => [
      row.supplierId,
      (row._sum.total ?? new Prisma.Decimal(0)).sub(row._sum.amountPaid ?? new Prisma.Decimal(0)),
    ]),
  );
  return rows.map((row) => toSummary(row, balanceMap.get(row.id) ?? new Prisma.Decimal(0)));
}

/** One supplier with its purchase-order history, newest first. */
export async function getSupplier(
  storeId: string,
  supplierId: string,
): Promise<SupplierSummary & { purchaseOrders: unknown[] }> {
  const prisma = getPrismaClient();
  const row = await prisma.supplier.findFirst({
    where: { id: supplierId, storeId },
    include: { _count: { select: { purchaseOrders: true } } },
  });
  if (row === null) {
    throw new AppError(404, "SUPPLIER_NOT_FOUND", "Supplier not found");
  }
  const [balanceDue, orders] = await Promise.all([
    supplierBalanceDue(storeId, supplierId),
    prisma.purchaseOrder.findMany({
      where: { storeId, supplierId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        number: true,
        status: true,
        total: true,
        amountPaid: true,
        createdAt: true,
        orderedAt: true,
        _count: { select: { lineItems: true } },
      },
    }),
  ]);
  return {
    ...toSummary(row, balanceDue),
    purchaseOrders: orders.map((order) => ({
      id: order.id,
      number: order.number,
      status: order.status,
      total: order.total.toFixed(2),
      amountPaid: order.amountPaid.toFixed(2),
      balanceDue: order.total.sub(order.amountPaid).toFixed(2),
      itemCount: order._count.lineItems,
      createdAt: order.createdAt,
      orderedAt: order.orderedAt,
    })),
  };
}

/** Creates a supplier; a (storeId, name) collision is 409 SUPPLIER_NAME_TAKEN. */
export async function createSupplier(
  storeId: string,
  staffMemberId: string | undefined,
  input: unknown,
): Promise<SupplierSummary> {
  const data = validateOrThrow(createSupplierSchema, input) as CreateSupplierInput;
  const prisma = getPrismaClient();
  let row: SupplierRowShape;
  try {
    row = await prisma.supplier.create({
      data: {
        storeId,
        name: data.name,
        contactName: data.contactName ?? null,
        phone: data.phone ?? null,
        email: data.email ?? null,
        address: data.address ?? null,
        isActive: data.isActive ?? true,
        notes: data.notes ?? null,
      },
      include: { _count: { select: { purchaseOrders: true } } },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && isUniqueViolation(err, "name")) {
      throw new AppError(409, "SUPPLIER_NAME_TAKEN", "A supplier with this name already exists");
    }
    throw err;
  }
  await logStoreActivity(prisma, {
    storeId,
    staffMemberId: staffMemberId ?? null,
    action: "supplier.created",
    detail: { supplierId: row.id, name: row.name },
  });
  return toSummary(row, new Prisma.Decimal(0));
}

/** Full replace of the editable fields; the conditional update is the 404 authority. */
export async function updateSupplier(
  storeId: string,
  supplierId: string,
  staffMemberId: string | undefined,
  input: unknown,
): Promise<SupplierSummary> {
  const data = validateOrThrow(updateSupplierSchema, input) as UpdateSupplierInput;
  const prisma = getPrismaClient();
  let updated: { count: number };
  try {
    updated = await prisma.supplier.updateMany({
      where: { id: supplierId, storeId },
      data: {
        name: data.name,
        contactName: data.contactName ?? null,
        phone: data.phone ?? null,
        email: data.email ?? null,
        address: data.address ?? null,
        isActive: data.isActive ?? true,
        notes: data.notes ?? null,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && isUniqueViolation(err, "name")) {
      throw new AppError(409, "SUPPLIER_NAME_TAKEN", "A supplier with this name already exists");
    }
    throw err;
  }
  if (updated.count === 0) {
    throw new AppError(404, "SUPPLIER_NOT_FOUND", "Supplier not found");
  }
  const row = await prisma.supplier.findUniqueOrThrow({
    where: { id: supplierId },
    include: { _count: { select: { purchaseOrders: true } } },
  });
  const balanceDue = await supplierBalanceDue(storeId, supplierId);
  await logStoreActivity(prisma, {
    storeId,
    staffMemberId: staffMemberId ?? null,
    action: "supplier.updated",
    detail: { supplierId, updatedFields: Object.keys(data) },
  });
  return toSummary(row, balanceDue);
}

/**
 * Ledger-safe deletion: allowed only while the supplier has no purchase
 * orders (the DB RESTRICT key is the backstop; the service classifies
 * the violation as 409 SUPPLIER_HAS_ORDERS).
 */
export async function deleteSupplier(
  storeId: string,
  supplierId: string,
  staffMemberId: string | undefined,
): Promise<void> {
  const prisma = getPrismaClient();
  const orderCount = await prisma.purchaseOrder.count({
    where: { storeId, supplierId },
  });
  if (orderCount > 0) {
    throw new AppError(
      409,
      "SUPPLIER_HAS_ORDERS",
      "Supplier has purchase-order history — set isActive to false instead",
    );
  }
  const deleted = await prisma.supplier.deleteMany({
    where: { id: supplierId, storeId },
  });
  if (deleted.count === 0) {
    throw new AppError(404, "SUPPLIER_NOT_FOUND", "Supplier not found");
  }
  await logStoreActivity(prisma, {
    storeId,
    staffMemberId: staffMemberId ?? null,
    action: "supplier.deleted",
    detail: { supplierId },
  });
}
