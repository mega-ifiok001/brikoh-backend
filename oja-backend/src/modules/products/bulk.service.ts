import type { Prisma, Subscription } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import { checkCap, resolvePlan } from "../subscriptions/plan.js";
import { bulkConfirmSchema, bulkImportRowSchema, bulkImportSchema } from "./bulk.schemas.js";
import { recordInitialStockChanges } from "./ledger.service.js";

/**
 * ============================================================
 * BULK PRODUCT IMPORT (two-phase: import → confirm)
 * ============================================================
 *
 * Phase 1 (startBulkImport) WRITES NOTHING to the catalog: it validates
 * every row, checks tenant ownership of category/unit refs, detects
 * duplicates (case-insensitive (storeId, name) — the key the unique
 * index enforces), and persists ONE ticket: a ProductImport row plus
 * per-row ProductImportRow rows (status NEW / DUPLICATE / ERROR) with a
 * 24h expiry. The ticket is the audit trail of the preview, and the
 * confirm phase re-reads LIVE state (catalog, stock, plan cap,
 * duplicates) instead of trusting anything precomputed.
 *
 * Phase 2 (confirmBulkImport) applies the ticket in ONE transaction:
 * NEW rows create products with the same pipeline as single-create
 * (eager BranchStock row on the default branch + INITIAL_STOCK ledger
 * entries through recordInitialStockChanges), explicitly resolved
 * duplicates overwrite their existing product (stock is NEVER touched —
 * initialStock on an overwrite is ignored), unlisted duplicates are
 * skipped, and one bulk.imported activity entry records the whole run.
 * Anything failing — plan cap, a NEW row colliding with a product
 * created after the import, a deleted catalog ref — rolls the
 * transaction back: no partial imports, ever.
 * ============================================================
 */

const IMPORT_TTL_MS = 24 * 60 * 60 * 1000;

/** Variants ride along on every product read, same include as the
 * products service (category/unit so the dashboard needs no second
 * round-trip). */
const variantsInclude = {
  variants: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
  category: true,
  unit: true,
} satisfies Prisma.ProductInclude;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof variantsInclude }>;

/** The canonical per-row value set: every voluntary field collapsed to
 * null / [] / 0 so the preview and the persisted row share one shape. */
interface NormalizedRow {
  rowNumber: number;
  name: string | null;
  price: string | null;
  costPrice: string | null;
  description: string | null;
  images: string[];
  coverImageUrl: string | null;
  categoryId: string | null;
  unitId: string | null;
  initialStock: number | null;
}

interface Disposition {
  rowNumber: number;
  status: "NEW" | "DUPLICATE" | "ERROR";
  errors: string[];
  existingProductId: string | null;
  existingName: string | null;
  normalized: NormalizedRow;
}

export interface BulkRowPreview {
  rowNumber: number;
  status: "new" | "duplicate" | "error";
  errors: string[];
  existingProductId: string | null;
  existingName: string | null;
  /** Set only for "new" rows: the validated values that WILL be created
   * on confirm (normalized, nothing persisted by phase 1). */
  product: Record<string, unknown> | null;
}

export interface BulkImportResult {
  importId: string;
  rows: BulkRowPreview[];
  summary: { new: number; duplicates: number; errors: number };
  expiresAt: Date;
}

export interface BulkConfirmResult {
  importId: string;
  created: ProductRow[];
  overwritten: ProductRow[];
  skipped: number[];
  failed: number[];
}

function normalizeRow(rowNumber: number, row: unknown): NormalizedRow {
  const parsed = bulkImportRowSchema.safeParse(row);
  if (!parsed.success) {
    return {
      rowNumber,
      name: null,
      price: null,
      costPrice: null,
      description: null,
      images: [],
      coverImageUrl: null,
      categoryId: null,
      unitId: null,
      initialStock: null,
    };
  }
  const data = parsed.data;
  return {
    rowNumber,
    name: data.name,
    price: data.price,
    costPrice: data.costPrice ?? null,
    description: data.description ?? null,
    images: data.images,
    coverImageUrl: data.coverImageUrl ?? null,
    categoryId: data.categoryId ?? null,
    unitId: data.unitId ?? null,
    initialStock: data.initialStock ?? null,
  };
}

function toPreview(row: NormalizedRow): Record<string, unknown> {
  return {
    name: row.name,
    price: row.price,
    costPrice: row.costPrice,
    description: row.description,
    images: row.images,
    coverImageUrl: row.coverImageUrl,
    categoryId: row.categoryId,
    unitId: row.unitId,
    initialStock: row.initialStock,
  };
}

/** Persisted-row shape: name/price stay null only for ERROR rows (the
 * errors array is their record); every other field is the normalized
 * null / [] / 0 value. */
function toPersistedRow(d: Disposition): Prisma.ProductImportRowCreateWithoutImportInput {
  return {
    rowNumber: d.rowNumber,
    name: d.normalized.name,
    price: d.normalized.price,
    costPrice: d.normalized.costPrice,
    description: d.normalized.description,
    images: d.normalized.images,
    coverImageUrl: d.normalized.coverImageUrl,
    categoryId: d.normalized.categoryId,
    unitId: d.normalized.unitId,
    initialStock: d.normalized.initialStock,
    status: d.status,
    errors: d.errors,
    ...(d.existingProductId !== null ? { existingProductId: d.existingProductId } : {}),
  };
}

/**
 * Phase 1 — validate + flag, then persist the ticket. Writes nothing to
 * the catalog. Per-row validation is non-throwing: a bad row is flagged
 * ERROR and never blocks the others (and can never be confirmed).
 */
export async function startBulkImport(
  storeId: string,
  staffMemberId: string | undefined,
  input: unknown,
): Promise<BulkImportResult> {
  const { rows } = validateOrThrow(bulkImportSchema, input) as { rows: unknown[] };
  const prisma = getPrismaClient();

  // 1. Per-row validation (errors collected, not thrown).
  const parsedRows = rows.map((row, index) => {
    const rowNumber = index + 1;
    const parsed = bulkImportRowSchema.safeParse(row);
    const normalized = normalizeRow(rowNumber, row);
    if (!parsed.success) {
      return {
        rowNumber,
        status: "ERROR" as const,
        errors: parsed.error.issues.map((issue) => issue.message),
        normalized,
      };
    }
    return { rowNumber, status: "NEW" as const, errors: [], normalized };
  });

  // 2. Tenant ownership of category/unit refs — a ref that does not
  // belong to the store flags the row (never fails the whole request).
  const categoryIds = [
    ...new Set(
      parsedRows
        .filter((r) => r.normalized.categoryId !== null)
        .map((r) => r.normalized.categoryId!),
    ),
  ];
  const unitIds = [
    ...new Set(
      parsedRows.filter((r) => r.normalized.unitId !== null).map((r) => r.normalized.unitId!),
    ),
  ];
  const [ownedCategories, ownedUnits] = await Promise.all([
    categoryIds.length === 0
      ? []
      : prisma.category.findMany({
          where: { id: { in: categoryIds }, storeId },
          select: { id: true },
        }),
    unitIds.length === 0
      ? []
      : prisma.unit.findMany({ where: { id: { in: unitIds }, storeId }, select: { id: true } }),
  ]);
  const ownedCategoryIds = new Set(ownedCategories.map((c) => c.id));
  const ownedUnitIds = new Set(ownedUnits.map((u) => u.id));
  for (const row of parsedRows) {
    const errors: string[] = [];
    if (row.normalized.categoryId !== null && !ownedCategoryIds.has(row.normalized.categoryId)) {
      errors.push(`categoryId does not belong to this store`);
    }
    if (row.normalized.unitId !== null && !ownedUnitIds.has(row.normalized.unitId)) {
      errors.push(`unitId does not belong to this store`);
    }
    if (errors.length > 0) {
      row.status = "ERROR";
      row.errors = [...row.errors, ...errors];
    }
  }

  // 3. Duplicate detection against the store's existing (non-deleted)
  // products by case-insensitive name — the same key the unique index
  // enforces, in the same collation direction (findMany mode
  // "insensitive" on Postgres lowercases both sides).
  const candidates = parsedRows.filter((r) => r.status === "NEW");
  const existing =
    candidates.length === 0
      ? []
      : await prisma.product.findMany({
          where: {
            storeId,
            deletedAt: null,
            name: { in: candidates.map((r) => r.normalized.name!), mode: "insensitive" },
          },
          select: { id: true, name: true },
        });
  const existingByLowerName = new Map(existing.map((p) => [p.name.toLowerCase(), p]));

  // 4. Intra-import collisions: the first occurrence wins; every later
  // row with the same (case-insensitive) name is flagged DUPLICATE.
  const dispositions: Disposition[] = [];
  const firstByLowerName = new Map<string, number>();
  for (const row of parsedRows) {
    let status: Disposition["status"] = row.status;
    let existingProductId: string | null = null;
    let existingName: string | null = null;
    if (status === "NEW") {
      const key = row.normalized.name!.toLowerCase();
      const firstRowNumber = firstByLowerName.get(key);
      if (firstRowNumber !== undefined) {
        status = "DUPLICATE";
        existingName = dispositions.find((d) => d.rowNumber === firstRowNumber)!.normalized.name;
      } else {
        const collision = existingByLowerName.get(key);
        if (collision !== undefined) {
          status = "DUPLICATE";
          existingProductId = collision.id;
          existingName = collision.name;
        } else {
          firstByLowerName.set(key, row.rowNumber);
        }
      }
    }
    dispositions.push({
      rowNumber: row.rowNumber,
      status,
      errors: row.errors,
      existingProductId,
      existingName,
      normalized: row.normalized,
    });
  }

  // 5. Persist the ticket atomically (import + rows commit or roll back
  // together) — still no catalog write.
  const expiresAt = new Date(Date.now() + IMPORT_TTL_MS);
  const ticket = await prisma.$transaction((tx) =>
    tx.productImport.create({
      data: {
        storeId,
        createdByStaffId: staffMemberId ?? null,
        status: "PENDING",
        expiresAt,
        rows: { create: dispositions.map(toPersistedRow) },
      },
    }),
  );

  const newCount = dispositions.filter((d) => d.status === "NEW").length;
  const duplicateCount = dispositions.filter((d) => d.status === "DUPLICATE").length;
  const errorCount = dispositions.filter((d) => d.status === "ERROR").length;
  return {
    importId: ticket.id,
    rows: dispositions.map((d) => ({
      rowNumber: d.rowNumber,
      status: d.status.toLowerCase() as "new" | "duplicate" | "error",
      errors: d.errors,
      existingProductId: d.existingProductId,
      existingName: d.existingName,
      product: d.status === "NEW" ? toPreview(d.normalized) : null,
    })),
    summary: { new: newCount, duplicates: duplicateCount, errors: errorCount },
    expiresAt,
  };
}

/**
 * The plan-cap gate for the CONFIRM transaction: rejects when the
 * store's current non-deleted product count PLUS the new rows of this
 * import would exceed the plan's productCap. Counting the planned rows
 * matters — a single-create-style count check would let a multi-row
 * import overshoot the cap. No subscription (or a null cap) = unlimited.
 */
async function enforceBulkProductCap(
  tx: Prisma.TransactionClient,
  storeId: string,
  newRowCount: number,
): Promise<void> {
  const store = await tx.store.findUnique({
    where: { id: storeId },
    select: { subscriptionId: true },
  });
  const subscription: Subscription | null =
    store?.subscriptionId !== null && store?.subscriptionId !== undefined
      ? await tx.subscription.findUnique({ where: { id: store!.subscriptionId! } })
      : null;
  const plan = resolvePlan(subscription);
  const cap = plan.limits.productCap;
  if (cap === null) return;
  const count = await tx.product.count({ where: { storeId, deletedAt: null } });
  const gate = checkCap(
    cap,
    count + newRowCount,
    "product",
    plan.tier === "STARTER" ? "PRO" : "ENTERPRISE",
  );
  if (!gate.allowed) {
    throw new AppError(409, "PRODUCT_LIMIT_REACHED", gate.message);
  }
}

/** Re-checks catalog ownership at confirm time: a category/unit deleted
 * (or moved) after the import must not be written. Fails the whole
 * confirm — nothing is applied. */
async function assertRefsOwned(
  tx: Prisma.TransactionClient,
  storeId: string,
  refs: { categoryId: string | null; unitId: string | null; rowNumber: number }[],
): Promise<void> {
  const categoryIds = [
    ...new Set(refs.filter((r) => r.categoryId !== null).map((r) => r.categoryId!)),
  ];
  const unitIds = [...new Set(refs.filter((r) => r.unitId !== null).map((r) => r.unitId!))];
  const [ownedCategories, ownedUnits] = await Promise.all([
    categoryIds.length === 0
      ? []
      : tx.category.findMany({ where: { id: { in: categoryIds }, storeId }, select: { id: true } }),
    unitIds.length === 0
      ? []
      : tx.unit.findMany({ where: { id: { in: unitIds }, storeId }, select: { id: true } }),
  ]);
  const ownedCategoryIds = new Set(ownedCategories.map((c) => c.id));
  const ownedUnitIds = new Set(ownedUnits.map((u) => u.id));
  for (const ref of refs) {
    if (ref.categoryId !== null && !ownedCategoryIds.has(ref.categoryId)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Row ${ref.rowNumber}: categoryId no longer belongs to this store — re-run the import preview`,
      );
    }
    if (ref.unitId !== null && !ownedUnitIds.has(ref.unitId)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Row ${ref.rowNumber}: unitId no longer belongs to this store — re-run the import preview`,
      );
    }
  }
}

/**
 * Phase 2 — apply the ticket. One transaction: cap gate first, then
 * default-branch lookup, then the live duplicate re-check for NEW rows,
 * then catalog-ref re-checks, then creates (with eager BranchStock rows
 * and INITIAL_STOCK ledger seeds) and confirmed overwrites, then the
 * ticket + row bookkeeping, then one bulk.imported activity entry.
 * Any failure rolls everything back.
 */
export async function confirmBulkImport(
  storeId: string,
  staffMemberId: string | undefined,
  input: unknown,
): Promise<BulkConfirmResult> {
  const { importId, resolveDuplicates } = validateOrThrow(bulkConfirmSchema, input) as {
    importId: string;
    resolveDuplicates: Record<string, "skip" | "overwrite">;
  };
  const prisma = getPrismaClient();

  const ticket = await prisma.productImport.findFirst({
    where: { id: importId, storeId },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (
    ticket === null ||
    ticket.storeId !== storeId ||
    ticket.status === "CONFIRMED" ||
    ticket.expiresAt.getTime() <= Date.now()
  ) {
    throw new AppError(
      404,
      "IMPORT_NOT_FOUND",
      "Bulk import ticket not found, expired, or already confirmed",
    );
  }

  // Resolutions must be explicit and coherent: numeric rowNumbers that
  // exist in the ticket, referring only to DUPLICATE rows with a real
  // existing product (never an error row, a new row, or an intra-import
  // duplicate — those cannot be overwritten).
  const rowsByNumber = new Map(ticket.rows.map((row) => [row.rowNumber, row]));
  const resolutions = new Map<number, "skip" | "overwrite">();
  for (const [key, value] of Object.entries(resolveDuplicates)) {
    const rowNumber = Number(key);
    if (!Number.isInteger(rowNumber) || rowNumber <= 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Invalid rowNumber "${key}" in resolveDuplicates`,
      );
    }
    const row = rowsByNumber.get(rowNumber);
    if (row === undefined) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `resolveDuplicates refers to row ${rowNumber}, which is not in this import`,
      );
    }
    if (row.status === "ERROR") {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Row ${rowNumber} has validation errors and cannot be confirmed`,
      );
    }
    if (row.status === "NEW") {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Row ${rowNumber} is a new row, not a duplicate — it cannot be resolved`,
      );
    }
    if (value === "overwrite" && row.existingProductId === null) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Row ${rowNumber} is an intra-import duplicate with no product to overwrite — only "skip" is allowed`,
      );
    }
    resolutions.set(rowNumber, value);
  }

  const newRows = ticket.rows.filter((row) => row.status === "NEW");
  const overwriteRows = ticket.rows.filter((row) => resolutions.get(row.rowNumber) === "overwrite");
  const skipped = ticket.rows
    .filter((row) => row.status === "DUPLICATE" && resolutions.get(row.rowNumber) !== "overwrite")
    .map((row) => row.rowNumber);

  const created: ProductRow[] = [];
  const overwritten: ProductRow[] = [];

  await prisma.$transaction(async (tx) => {
    // Cap INSIDE the transaction so a concurrent product create cannot
    // let the import sneak past the plan gate.
    await enforceBulkProductCap(tx, storeId, newRows.length);

    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: { defaultBranchId: true },
    });
    if (store === null || store.defaultBranchId === null) {
      throw new AppError(
        409,
        "STORE_NOT_CONFIGURED",
        "This store has no default branch — create one before importing products",
      );
    }
    const branchId = store.defaultBranchId;

    // Fresh duplicate detection: a product created AFTER the import with
    // a new row's name is a hard conflict — the merchant must re-run the
    // preview. (NEW rows cannot collide with each other: intra-import
    // duplicates were already flagged at import time.)
    if (newRows.length > 0) {
      const live = await tx.product.findMany({
        where: {
          storeId,
          deletedAt: null,
          name: { in: newRows.map((row) => row.name!), mode: "insensitive" },
        },
        select: { name: true },
      });
      if (live.length > 0) {
        const collided = new Set(live.map((p) => p.name.toLowerCase()));
        const numbers = newRows
          .filter((row) => collided.has(row.name!.toLowerCase()))
          .map((row) => row.rowNumber);
        throw new AppError(
          409,
          "DUPLICATE_NAME",
          `Row(s) ${numbers.join(", ")} now collide with an existing product — re-run the import preview`,
        );
      }
    }

    await assertRefsOwned(
      tx,
      storeId,
      [...newRows, ...overwriteRows].map((row) => ({
        rowNumber: row.rowNumber,
        categoryId: row.categoryId,
        unitId: row.unitId,
      })),
    );

    for (const row of newRows) {
      const product = await tx.product.create({
        data: {
          storeId,
          name: row.name!,
          price: row.price!,
          costPrice: row.costPrice,
          description: row.description,
          images: row.images,
          coverImageUrl: row.coverImageUrl,
          ...(row.categoryId !== null ? { categoryId: row.categoryId } : {}),
          ...(row.unitId !== null ? { unitId: row.unitId } : {}),
        },
        include: variantsInclude,
      });
      // EAGER BRANCH STOCK ROW (the branch-stock invariant): exactly one
      // row per (branch, product) so every movement has a guarded target.
      await tx.branchStock.create({
        data: { storeId, branchId, productId: product.id, variantId: null, quantity: 0 },
      });
      // Seed movements through the ledger — never a direct quantity
      // write — reason INITIAL_STOCK, same pipeline as single-create.
      if (row.initialStock !== null) {
        await recordInitialStockChanges(tx, [
          { storeId, branchId, productId: product.id, quantityChange: row.initialStock },
        ]);
      }
      await tx.productImportRow.update({
        where: { importId_rowNumber: { importId, rowNumber: row.rowNumber } },
        data: { createdProductId: product.id },
      });
      created.push(product);
    }

    for (const row of overwriteRows) {
      // Overwrite = full replacement of the row's fields (including
      // clearing categoryId/unitId to null when the row has none).
      // initialStock is deliberately absent: stock only moves through
      // the ledger, and an overwrite never touches it.
      const updated = await tx.product.updateMany({
        where: { id: row.existingProductId!, storeId, deletedAt: null },
        data: {
          name: row.name!,
          price: row.price!,
          costPrice: row.costPrice,
          description: row.description,
          images: row.images,
          coverImageUrl: row.coverImageUrl,
          categoryId: row.categoryId,
          unitId: row.unitId,
        },
      });
      if (updated.count === 0) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          `Row ${row.rowNumber}: the product to overwrite no longer exists — re-run the import preview`,
        );
      }
      const product = await tx.product.findUniqueOrThrow({
        where: { id: row.existingProductId! },
        include: variantsInclude,
      });
      await tx.productImportRow.update({
        where: { importId_rowNumber: { importId, rowNumber: row.rowNumber } },
        data: { overwrite: true, existingProductId: row.existingProductId },
      });
      overwritten.push(product);
    }

    await tx.productImport.update({
      where: { id: importId },
      data: { status: "CONFIRMED", confirmedAt: new Date() },
    });

    // One activity entry for the whole run, inside the transaction (a
    // rolled-back import leaves no orphan log row).
    await logStoreActivity(tx, {
      storeId,
      staffMemberId,
      action: "bulk.imported",
      detail: {
        importId,
        created: created.length,
        overwritten: overwritten.length,
        skipped: skipped.length,
        failed: 0,
      },
    });
  });

  return { importId, created, overwritten, skipped, failed: [] };
}
