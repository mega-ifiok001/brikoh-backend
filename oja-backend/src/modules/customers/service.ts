import { Prisma, type $Enums, type PrismaClient } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { parseCsv, toCsv } from "../../lib/csv.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { phoneSchema } from "../../lib/validation.js";
import { validateOrThrow } from "../../lib/validate.js";
import { emailSchema } from "../auth/schemas.js";
import { logStoreActivity } from "../activity/service.js";
import { SALES_STATUSES } from "../analytics/constants.js";
import { ensureDefaultGroup } from "../customer-groups/service.js";
import { defaultAlertSender } from "../notifications/email.js";
import { notifyPaymentReceived, NOTIFICATION_REF_TYPES } from "../notifications/service.js";
import { listOrders } from "../orders/service.js";
import { computeCustomerSegment, type CustomerSegment } from "./constants.js";
import {
  creditRepaymentSchema,
  customerCreateSchema,
  customerUpdateSchema,
  listCustomersParamsSchema,
  type CreditRepaymentInput,
  type CustomerCreateInput,
  type CustomerUpdateInput,
  type ListCustomersParams,
} from "./schemas.js";

/**
 * ============================================================
 * CUSTOMERS SERVICE — address book + credit repayments
 * ============================================================
 * The explicit management surface for Customer rows (POS/checkout
 * create them implicitly). Credit balances are derived, never stored:
 * a CREDIT order with amountPaid < total has an outstanding balance,
 * restricted to COLLECTIBLE statuses (PENDING | PAID | SHIPPED) so
 * cancelled/refunded/failed orders never count as owing.
 *
 * Repayments are append-only financial records (CreditRepayment rows,
 * DB trigger-enforced): order.amountPaid advances, distribution is
 * oldest-first, and every repayment is visible on the order detail and
 * in the customer timeline. The overview's creditOwing applies the same
 * predicate (see getOverview).
 * ============================================================
 */

export const COLLECTIBLE_ORDER_STATUSES = ["PENDING", "PAID", "SHIPPED"] as const;
export type CollectibleOrderStatus = (typeof COLLECTIBLE_ORDER_STATUSES)[number];

/**
 * The single open-credit predicate: CREDIT orders in a collectible
 * status with amountPaid below total. Shared by the customer list,
 * detail, repayments, and the dashboard overview's creditOwing.
 */
export function openCreditOrderWhere(
  prisma: Prisma.TransactionClient,
  storeId: string,
): Prisma.OrderWhereInput {
  return {
    storeId,
    paymentMethod: "CREDIT",
    status: { in: [...COLLECTIBLE_ORDER_STATUSES] as $Enums.OrderStatus[] },
    amountPaid: { lt: prisma.order.fields.total },
  };
}

/** Sums (total - amountPaid) over open credit rows per customer. */
function openCreditByCustomer(
  rows: readonly { customerId: string; total: Prisma.Decimal; amountPaid: Prisma.Decimal | null }[],
): Map<string, Prisma.Decimal> {
  const byCustomer = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    const outstanding = row.total.sub(row.amountPaid ?? new Prisma.Decimal(0));
    byCustomer.set(
      row.customerId,
      (byCustomer.get(row.customerId) ?? new Prisma.Decimal(0)).add(outstanding),
    );
  }
  return byCustomer;
}

export interface CustomerGroupRef {
  id: string;
  name: string;
}

export interface CustomerSummary {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  group: CustomerGroupRef | null;
  source: $Enums.CustomerSource;
  segment: CustomerSegment;
  ordersCount: number;
  totalSpent: string;
  openCredit: string;
  hasOutstandingCredit: boolean;
  createdAt: Date;
}

export interface CustomersPage {
  items: CustomerSummary[];
  nextCursor: string | null;
}

/** Raw customer rows shared by the list, the detail, and the CSV export. */
type CustomerRawRow = Prisma.CustomerGetPayload<{
  select: typeof customerSelect;
}>;

const customerSelect = {
  id: true,
  name: true,
  phone: true,
  email: true,
  source: true,
  createdAt: true,
  group: { select: { id: true, name: true } },
} satisfies Prisma.CustomerSelect;

/**
 * Derives ordersCount, totalSpent (successful sales only), and the
 * live segment for a set of customer rows in one round-trip each.
 * `rows` may be empty: the maps stay empty and every row becomes a
 * NEW segment with zero spend.
 */
async function enrichCustomerRows(
  prisma: PrismaClient,
  storeId: string,
  rows: readonly { id: string }[],
): Promise<Map<string, { ordersCount: number; totalSpent: Prisma.Decimal }>> {
  const ids = rows.map((row) => row.id);
  const byCustomer = new Map<string, { ordersCount: number; totalSpent: Prisma.Decimal }>();
  if (ids.length === 0) {
    return byCustomer;
  }
  const [orderCounts, spendRows] = await Promise.all([
    prisma.order.groupBy({
      by: ["customerId"],
      where: { storeId, customerId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.order.groupBy({
      by: ["customerId"],
      where: { storeId, customerId: { in: ids }, status: { in: [...SALES_STATUSES] } },
      _sum: { total: true },
    }),
  ]);
  const spendByCustomer = new Map<string, Prisma.Decimal>();
  for (const row of spendRows) {
    spendByCustomer.set(row.customerId, row._sum?.total ?? new Prisma.Decimal(0));
  }
  for (const row of orderCounts) {
    byCustomer.set(row.customerId, {
      ordersCount: row._count._all,
      totalSpent: spendByCustomer.get(row.customerId) ?? new Prisma.Decimal(0),
    });
  }
  for (const row of rows) {
    if (!byCustomer.has(row.id)) {
      byCustomer.set(row.id, {
        ordersCount: 0,
        totalSpent: new Prisma.Decimal(0),
      });
    }
  }
  return byCustomer;
}

/** Assembles a full summary row (credit + spend + segment) from raw rows. */
function toSummary(
  row: CustomerRawRow,
  openCredit: ReadonlyMap<string, Prisma.Decimal>,
  stats: ReadonlyMap<string, { ordersCount: number; totalSpent: Prisma.Decimal }>,
): CustomerSummary {
  const balance = openCredit.get(row.id) ?? new Prisma.Decimal(0);
  const derived = stats.get(row.id)!;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    group: row.group,
    source: row.source,
    segment: computeCustomerSegment(derived.ordersCount, derived.totalSpent),
    ordersCount: derived.ordersCount,
    totalSpent: derived.totalSpent.toFixed(2),
    openCredit: balance.toFixed(2),
    hasOutstandingCredit: !balance.isZero(),
    createdAt: row.createdAt,
  };
}

/** Cursor-paginated, newest-first address book with derived open credit. */
export async function listCustomers(storeId: string, rawParams: unknown): Promise<CustomersPage> {
  const params = validateOrThrow(listCustomersParamsSchema, rawParams) as ListCustomersParams;
  const prisma = getPrismaClient();

  const where: Prisma.CustomerWhereInput = { storeId };
  if (params.q !== undefined) {
    where.OR = [
      { name: { contains: params.q, mode: "insensitive" } },
      { phone: { contains: params.q, mode: "insensitive" } },
      { email: { contains: params.q, mode: "insensitive" } },
    ];
  }
  if (params.cursor !== undefined) where.id = { lt: params.cursor };

  const [rows, openRows] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: params.limit,
      select: customerSelect,
    }),
    prisma.order.findMany({
      where: openCreditOrderWhere(prisma, storeId),
      select: { customerId: true, total: true, amountPaid: true },
    }),
  ]);

  const openCredit = openCreditByCustomer(openRows);
  const stats = await enrichCustomerRows(prisma, storeId, rows);
  let items: CustomerSummary[] = rows.map((row) => toSummary(row, openCredit, stats));

  if (params.hasOutstandingCredit !== undefined) {
    items = items.filter((item) => item.hasOutstandingCredit === params.hasOutstandingCredit);
  }

  const nextCursor =
    rows.length === params.limit && rows.length > 0 ? rows[rows.length - 1]!.id : null;
  return { items, nextCursor };
}

export interface CustomerRepayment {
  id: string;
  orderId: string;
  amount: string;
  note: string | null;
  recordedByName: string | null;
  createdAt: Date;
}

export interface CustomerRecentOrder {
  id: string;
  status: string;
  paymentMethod: string | null;
  source: string;
  total: string;
  amountPaid: string | null;
  balanceDue: string;
  createdAt: Date;
}

export interface CustomerDetail {
  customer: CustomerSummary;
  repayments: CustomerRepayment[];
  recentOrders: CustomerRecentOrder[];
}

async function customerRow(storeId: string, customerId: string) {
  const prisma = getPrismaClient();
  const row = await prisma.customer.findFirst({
    where: { id: customerId, storeId },
    select: customerSelect,
  });
  if (row === null) {
    throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
  }
  return row;
}

/** One customer with its credit state, repayment timeline, and recent orders. */
export async function getCustomerDetail(
  storeId: string,
  customerId: string,
): Promise<CustomerDetail> {
  const prisma = getPrismaClient();
  const row = await customerRow(storeId, customerId);
  const [openRows, repayments, stats] = await Promise.all([
    prisma.order.findMany({
      where: { ...openCreditOrderWhere(prisma, storeId), customerId },
      select: { total: true, amountPaid: true },
    }),
    prisma.creditRepayment.findMany({
      where: { storeId, order: { customerId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      select: {
        id: true,
        orderId: true,
        amount: true,
        note: true,
        recordedByStaff: {
          select: { account: { select: { firstName: true, lastName: true, email: true } } },
        },
        createdAt: true,
      },
    }),
    enrichCustomerRows(prisma, storeId, [row]),
  ]);

  const balance = openRows.reduce(
    (sum, order) => sum.add(order.total.sub(order.amountPaid ?? new Prisma.Decimal(0))),
    new Prisma.Decimal(0),
  );

  const page = await listOrders(storeId, { customerId, limit: 10 });
  const recentOrders: CustomerRecentOrder[] = page.items.map((order) => ({
    id: order.id,
    status: order.status,
    paymentMethod: order.paymentMethod,
    source: order.source,
    total: order.total,
    amountPaid: order.amountPaid,
    balanceDue: order.balanceDue,
    createdAt: order.createdAt,
  }));

  return {
    customer: toSummary(row, new Map([[row.id, balance]]), stats),
    repayments: repayments.map((repayment) => ({
      id: repayment.id,
      orderId: repayment.orderId,
      amount: repayment.amount.toFixed(2),
      note: repayment.note,
      recordedByName:
        repayment.recordedByStaff === null
          ? null
          : [
              repayment.recordedByStaff.account.firstName,
              repayment.recordedByStaff.account.lastName,
            ]
              .filter((part): part is string => part !== null && part !== undefined)
              .join(" ") || repayment.recordedByStaff.account.email,
      createdAt: repayment.createdAt,
    })),
    recentOrders,
  };
}

/** Creates an address-book entry (explicit path; POS/checkout create implicitly). */
export async function createCustomer(
  storeId: string,
  staffMemberId: string | undefined,
  rawInput: unknown,
): Promise<CustomerSummary> {
  const data = validateOrThrow(customerCreateSchema, rawInput) as CustomerCreateInput;
  const prisma = getPrismaClient();

  // Advisory duplicate check: the DB has no unique constraint on email,
  // so this is a pre-check that races are still possible.
  if (data.email !== undefined && data.email !== null) {
    const existing = await prisma.customer.findFirst({ where: { storeId, email: data.email } });
    if (existing !== null) {
      throw new AppError(409, "CUSTOMER_EXISTS", "A customer with this email already exists");
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    // Explicit group must belong to the tenant; omitted = the store's
    // default "General" group (created lazily on first use).
    const groupId =
      data.groupId === undefined || data.groupId === null
        ? await ensureDefaultGroup(tx, storeId)
        : await assertGroupInStore(tx, storeId, data.groupId);
    const customer = await tx.customer.create({
      data: {
        storeId,
        name: data.name,
        phone: data.phone ?? null,
        email: data.email ?? null,
        source: "MANUAL",
        groupId,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        source: true,
        createdAt: true,
        group: { select: { id: true, name: true } },
      },
    });
    await logStoreActivity(tx, {
      storeId,
      staffMemberId: staffMemberId ?? null,
      action: "customer.created",
      detail: { customerId: customer.id },
    });
    return customer;
  });

  return {
    id: created.id,
    name: created.name,
    phone: created.phone,
    email: created.email,
    group: created.group,
    source: created.source,
    segment: "NEW",
    ordersCount: 0,
    totalSpent: "0.00",
    openCredit: "0.00",
    hasOutstandingCredit: false,
    createdAt: created.createdAt,
  };
}

/** Updates the profile; omitted fields keep their value, explicit null clears. */
export async function updateCustomer(
  storeId: string,
  staffMemberId: string | undefined,
  customerId: string,
  rawInput: unknown,
): Promise<CustomerSummary> {
  const data = validateOrThrow(customerUpdateSchema, rawInput) as CustomerUpdateInput;
  const prisma = getPrismaClient();

  const row = await customerRow(storeId, customerId);
  if (data.email !== undefined && data.email !== null) {
    const existing = await prisma.customer.findFirst({
      where: { storeId, email: data.email, id: { not: customerId } },
    });
    if (existing !== null) {
      throw new AppError(409, "CUSTOMER_EXISTS", "A customer with this email already exists");
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    let groupId: string | null | undefined;
    if (data.groupId !== undefined) {
      groupId = data.groupId === null ? null : await assertGroupInStore(tx, storeId, data.groupId);
    }
    const customer = await tx.customer.update({
      where: { id: row.id },
      data: {
        name: data.name,
        phone: data.phone,
        email: data.email,
        ...(groupId !== undefined ? { groupId } : {}),
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        source: true,
        createdAt: true,
        group: { select: { id: true, name: true } },
      },
    });
    await logStoreActivity(tx, {
      storeId,
      staffMemberId: staffMemberId ?? null,
      action: "customer.updated",
      detail: { customerId: customer.id },
    });
    return customer;
  });

  const balance = await openCreditForCustomer(storeId, customerId);
  const stats = await enrichCustomerRows(getPrismaClient(), storeId, [updated]);
  const derived = stats.get(updated.id)!;
  return {
    id: updated.id,
    name: updated.name,
    phone: updated.phone,
    email: updated.email,
    group: updated.group,
    source: updated.source,
    segment: computeCustomerSegment(derived.ordersCount, derived.totalSpent),
    ordersCount: derived.ordersCount,
    totalSpent: derived.totalSpent.toFixed(2),
    openCredit: balance.toFixed(2),
    hasOutstandingCredit: !balance.isZero(),
    createdAt: updated.createdAt,
  };
}

async function openCreditForCustomer(storeId: string, customerId: string): Promise<Prisma.Decimal> {
  const prisma = getPrismaClient();
  const rows = await prisma.order.findMany({
    where: { ...openCreditOrderWhere(prisma, storeId), customerId },
    select: { total: true, amountPaid: true },
  });
  return rows.reduce(
    (sum, order) => sum.add(order.total.sub(order.amountPaid ?? new Prisma.Decimal(0))),
    new Prisma.Decimal(0),
  );
}

/**
 * Deletes a customer with no financial history. Order/Invoice Restrict
 * guards are surfaced as a clear 409 (branches pattern).
 */
export async function deleteCustomer(
  storeId: string,
  staffMemberId: string | undefined,
  customerId: string,
): Promise<void> {
  const prisma = getPrismaClient();
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.customer.findFirst({ where: { id: customerId, storeId } });
      if (row === null) {
        throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
      }
      await tx.customer.delete({ where: { id: customerId } });
      await logStoreActivity(tx, {
        storeId,
        staffMemberId: staffMemberId ?? null,
        action: "customer.deleted",
        detail: { customerId },
      });
    });
  } catch (err) {
    // Order/Invoice Restrict guards: a customer with financial history
    // cannot be deleted at the DB level — surface it as a clear 409.
    // Prisma 7 with the pg driver adapter reports FK restrict violations
    // as P2039 (nested driver code 23001); engine-based clients used
    // P2003, so both are handled.
    const knownErr = err as { code?: string; meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } };
    const code = knownErr.code ?? knownErr.meta?.driverAdapterError?.cause?.originalCode;
    if (code === "P2003" || code === "P2039" || code === "23001") {
      throw new AppError(
        409,
        "CUSTOMER_HAS_RECORDS",
        "This customer has order or invoice history and cannot be deleted",
      );
    }
    throw err;
  }
}

export interface CreditRepaymentAllocation {
  orderId: string;
  amount: string;
}

export interface CreditRepaymentResult {
  allocated: CreditRepaymentAllocation[];
  remaining: string;
  totalOutstanding: string;
}

/**
 * Records a repayment against the customer's outstanding credit.
 * Oldest-first distribution; one CreditRepayment ledger row per order
 * touched; order.amountPaid advances. Over-payment and zero-balance are
 * rejected upfront (409), so `remaining` is always "0.00".
 */
export async function recordCreditRepayment(
  storeId: string,
  staffMemberId: string | undefined,
  customerId: string,
  rawInput: unknown,
): Promise<CreditRepaymentResult> {
  const data = validateOrThrow(creditRepaymentSchema, rawInput) as CreditRepaymentInput;
  const amount = new Prisma.Decimal(data.amount);
  const prisma = getPrismaClient();

  const repaymentIds: string[] = [];
  const result = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { id: customerId, storeId },
      select: { id: true },
    });
    if (customer === null) {
      throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
    }

    const openOrders = await tx.order.findMany({
      where: { ...openCreditOrderWhere(tx, storeId), customerId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, total: true, amountPaid: true },
    });

    const totalOutstanding = openOrders.reduce(
      (sum, order) => sum.add(order.total.sub(order.amountPaid ?? new Prisma.Decimal(0))),
      new Prisma.Decimal(0),
    );
    if (totalOutstanding.isZero()) {
      throw new AppError(409, "NO_OUTSTANDING_CREDIT", "This customer has no open credit balance");
    }
    if (amount.greaterThan(totalOutstanding)) {
      throw new AppError(
        409,
        "REPAYMENT_EXCEEDS_BALANCE",
        `Repayment exceeds the outstanding balance of ${totalOutstanding.toFixed(2)}`,
      );
    }

    const allocated: CreditRepaymentAllocation[] = [];
    let remaining = amount;
    for (const order of openOrders) {
      if (remaining.isZero()) break;
      const balance = order.total.sub(order.amountPaid ?? new Prisma.Decimal(0));
      const pay = Prisma.Decimal.min(remaining, balance);
      await tx.order.update({
        where: { id: order.id },
        data: { amountPaid: (order.amountPaid ?? new Prisma.Decimal(0)).add(pay) },
      });
      const repayment = await tx.creditRepayment.create({
        data: {
          storeId,
          orderId: order.id,
          amount: pay,
          note: data.note ?? null,
          recordedByStaffId: staffMemberId ?? null,
        },
        select: { id: true },
      });
      repaymentIds.push(repayment.id);
      allocated.push({ orderId: order.id, amount: pay.toFixed(2) });
      remaining = remaining.sub(pay);
    }

    await logStoreActivity(tx, {
      storeId,
      staffMemberId: staffMemberId ?? null,
      action: "credit.repayment.recorded",
      detail: {
        customerId,
        amount: data.amount,
        ordersTouched: allocated.length,
      },
    });

    return {
      allocated,
      remaining: remaining.toFixed(2),
      totalOutstanding: totalOutstanding.toFixed(2),
    };
  });

  // Money is committed; alert the owner per repayment ledger row
  // (best-effort — a send failure never surfaces here).
  for (const repaymentId of repaymentIds) {
    await notifyPaymentReceived(
      defaultAlertSender(),
      storeId,
      NOTIFICATION_REF_TYPES.CREDIT_REPAYMENT,
      repaymentId,
    );
  }

  return result;
}

/** Verifies a group belongs to the tenant; unknown/cross-tenant = 404. */
async function assertGroupInStore(
  client: Prisma.TransactionClient,
  storeId: string,
  groupId: string,
): Promise<string> {
  const group = await client.customerGroup.findFirst({
    where: { id: groupId, storeId },
    select: { id: true },
  });
  if (group === null) {
    throw new AppError(404, "CUSTOMER_GROUP_NOT_FOUND", "Customer group not found");
  }
  return group.id;
}

/**
 * ============================================================
 * CSV EXPORT / IMPORT (dashboard-customers.md)
 * ============================================================
 * Export: the whole address book, newest-first, with the same derived
 * columns as the list (segment/totalSpent computed live at export
 * time). Import: one-phase and atomic — the batch is validated before
 * any write and inserted in a single transaction; duplicates are
 * skipped, never errors.
 * ============================================================
 */

/** Full address book as RFC 4180 CSV (name, phone, email, group,
 * source, segment, ordersCount, totalSpent, openCredit, createdAt). */
export async function exportCustomers(storeId: string): Promise<string> {
  const prisma = getPrismaClient();
  const [rows, openRows] = await Promise.all([
    prisma.customer.findMany({
      where: { storeId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: customerSelect,
    }),
    prisma.order.findMany({
      where: openCreditOrderWhere(prisma, storeId),
      select: { customerId: true, total: true, amountPaid: true },
    }),
  ]);
  const openCredit = openCreditByCustomer(openRows);
  const stats = await enrichCustomerRows(prisma, storeId, rows);
  const summaries = rows.map((row) => toSummary(row, openCredit, stats));
  return toCsv(
    summaries.map((row) => ({
      name: row.name,
      phone: row.phone ?? "",
      email: row.email ?? "",
      group: row.group?.name ?? "",
      source: row.source,
      segment: row.segment,
      ordersCount: String(row.ordersCount),
      totalSpent: row.totalSpent,
      openCredit: row.openCredit,
      createdAt: row.createdAt.toISOString(),
    })),
  );
}

export interface CustomerImportResult {
  created: number;
  skipped: number;
  errors: string[];
}

/** The CSV columns the importer understands, in any order. */
const IMPORT_HEADERS = ["name", "phone", "email", "groupId"] as const;
const MAX_IMPORT_ROWS = 500;

/**
 * One-phase atomic import. File-level failures (malformed CSV, unknown
 * headers, > 500 rows, an unknown groupId, a row without phone or
 * email) reject the whole batch with 400 — nothing is written. Per-row
 * data errors (bad phone/email, missing name) are reported in `errors`
 * while the valid rows still import. Duplicates — email-then-phone
 * against the store's existing address book, and repeats within the
 * file (first wins) — are skipped, never errors.
 */
export async function importCustomers(
  storeId: string,
  staffMemberId: string | undefined,
  rawBody: unknown,
): Promise<CustomerImportResult> {
  const prisma = getPrismaClient();
  if (typeof rawBody !== "string" || rawBody.trim() === "") {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "The import body must be raw CSV text (Content-Type: text/csv)",
    );
  }

  let parsed: string[][];
  try {
    parsed = parseCsv(rawBody);
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Malformed CSV");
  }
  if (parsed.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "Malformed CSV");
  }

  const headers = parsed[0]!.map((header) => header.trim().toLowerCase());
  const headerSet = new Set(headers);
  if (
    headers.length !== new Set(headers).size ||
    !headers.every((header) => (IMPORT_HEADERS as readonly string[]).includes(header))
  ) {
    throw new AppError(400, "VALIDATION_ERROR", "Unknown CSV header column");
  }
  if (!headerSet.has("name")) {
    throw new AppError(400, "VALIDATION_ERROR", "The CSV must include a name column");
  }

  const dataRows = parsed.slice(1);
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new AppError(400, "VALIDATION_ERROR", `At most ${MAX_IMPORT_ROWS} rows per import`);
  }

  // File-level reference check: every groupId must belong to the store.
  const requestedGroupIds = new Set<string>();
  for (const rawRow of dataRows) {
    const groupId = rawRow[headers.indexOf("groupId")]?.trim() ?? "";
    if (groupId !== "") {
      requestedGroupIds.add(groupId);
    }
  }
  const knownGroups = await prisma.customerGroup.findMany({
    where: { storeId, id: { in: [...requestedGroupIds] } },
    select: { id: true },
  });
  const knownGroupIds = new Set(knownGroups.map((group) => group.id));
  const unknownGroupId = [...requestedGroupIds].find((id) => !knownGroupIds.has(id));
  if (unknownGroupId !== undefined) {
    throw new AppError(400, "VALIDATION_ERROR", `Unknown groupId: ${unknownGroupId}`);
  }

  // Row validation: per-row problems are collected, file-level ones reject.
  const errors: string[] = [];
  const valid: {
    name: string;
    phone: string | null;
    email: string | null;
    groupId: string | null;
  }[] = [];
  let skipped = 0;
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();

  const nameIndex = headers.indexOf("name");
  const phoneIndex = headers.indexOf("phone");
  const emailIndex = headers.indexOf("email");
  const groupIndex = headers.indexOf("groupId");

  dataRows.forEach((rawRow, index) => {
    const rowNumber = index + 2; // 1-indexed incl. header
    const name = (rawRow[nameIndex] ?? "").trim();
    const phone = (rawRow[phoneIndex] ?? "").trim();
    const email = (rawRow[emailIndex] ?? "").trim().toLowerCase();
    const groupId = (rawRow[groupIndex] ?? "").trim() || null;

    if (name === "" && phone === "" && email === "" && groupId === null) {
      skipped += 1;
      return;
    }
    if (name === "" || name.length > 200) {
      errors.push(`row ${rowNumber}: name is required (1-200 chars)`);
      return;
    }
    let normalizedPhone: string | null = null;
    if (phone !== "") {
      const parsedPhone = phoneSchema.safeParse(phone);
      if (!parsedPhone.success) {
        errors.push(`row ${rowNumber}: invalid phone`);
        return;
      }
      normalizedPhone = parsedPhone.data;
    }
    let normalizedEmail: string | null = null;
    if (email !== "") {
      const parsedEmail = emailSchema.safeParse(email);
      if (!parsedEmail.success) {
        errors.push(`row ${rowNumber}: invalid email`);
        return;
      }
      normalizedEmail = parsedEmail.data;
    }
    if (normalizedPhone === null && normalizedEmail === null) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `row ${rowNumber}: at least one of phone or email is required`,
      );
    }

    // In-file duplicates: first row wins, later ones are skipped.
    if (
      normalizedEmail !== null &&
      (seenEmails.has(normalizedEmail) || seenPhones.has(normalizedPhone ?? ""))
    ) {
      skipped += 1;
      return;
    }
    if (normalizedPhone !== null && seenPhones.has(normalizedPhone)) {
      skipped += 1;
      return;
    }
    if (normalizedEmail !== null) {
      seenEmails.add(normalizedEmail);
    }
    if (normalizedPhone !== null) {
      seenPhones.add(normalizedPhone);
    }

    valid.push({ name, phone: normalizedPhone, email: normalizedEmail, groupId });
  });

  if (valid.length === 0) {
    return { created: 0, skipped: dataRows.length - errors.length, errors };
  }

  // DB-level duplicates: email match wins over phone match ("by
  // email-then-phone").
  const emails = [...seenEmails];
  const phones = [...seenPhones];
  const existing = await prisma.customer.findMany({
    where: {
      storeId,
      OR: [{ email: { in: emails } }, ...(phones.length > 0 ? [{ phone: { in: phones } }] : [])],
    },
    select: { email: true, phone: true },
  });
  const existingEmails = new Set(existing.map((row) => row.email));
  const existingPhones = new Set(existing.map((row) => row.phone));

  const toInsert = valid.filter((row) => {
    if (row.email !== null && existingEmails.has(row.email)) {
      skipped += 1;
      return false;
    }
    if (row.phone !== null && existingPhones.has(row.phone)) {
      skipped += 1;
      return false;
    }
    return true;
  });

  if (toInsert.length === 0) {
    return { created: 0, skipped, errors };
  }

  const created = await prisma.$transaction(async (tx) => {
    const generalGroupId = await ensureDefaultGroup(tx, storeId);
    let count = 0;
    for (const row of toInsert) {
      await tx.customer.create({
        data: {
          storeId,
          name: row.name,
          phone: row.phone,
          email: row.email,
          source: "IMPORTED",
          groupId: row.groupId ?? generalGroupId,
        },
      });
      count += 1;
    }
    return count;
  });

  await logStoreActivity(prisma, {
    storeId,
    staffMemberId: staffMemberId ?? null,
    action: "customer.imported",
    detail: { created, skipped },
  });

  return { created, skipped, errors };
}
