import type { $Enums, Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";

/**
 * ============================================================
 * STOCK LEDGER — THE ONLY APPROVED WAY TO CHANGE STOCK
 * ============================================================
 *
 * BranchStock.quantity (per branch, per product/variant) is the
 * authoritative stock number. Product.quantity and
 * ProductVariant.quantity are denormalized CROSS-BRANCH TOTALS of the
 * ledger, cached for fast reads. Neither must EVER be written directly
 * (no product.update/updateMany setting quantity from a controller).
 * Every change flows through applyStockChange, which performs the
 * BranchStock update, the total updates, and the StockLedgerEntry
 * insert in ONE transaction, so the ledger and the cached numbers can
 * never diverge.
 *
 * BRANCH DIMENSION
 * ----------------
 * Every movement names a branch (branchId on the ledger row). The
 * guarded update targets the branch's BranchStock row — a transfer
 * writes TRANSFER_OUT on the source branch and TRANSFER_IN on the
 * destination in one transaction (they cancel on the totals).
 * The invariant "exactly one BranchStock row per (branch, product,
 * variant)" holds via eager creation at product creation plus the
 * ensure-on-restock path here, backstopped by partial unique indexes
 * in the branches migration.
 *
 * VARIANT DIMENSION
 * -----------------
 * A product either has variants or it doesn't, decided at creation:
 *  - No variants: movements target the variant-less BranchStock row
 *    (variantId = null), ledger rows carry variantId = null — today's
 *    single-SKU behavior, unchanged.
 *  - Has variants: EVERY movement MUST name a variant (else 400
 *    VARIANT_REQUIRED). The movement targets the variant's BranchStock
 *    row and the ledger row carries the variantId. Product.quantity is
 *    meaningless for such products — per-variant stock is the only
 *    truth, never a single number.
 * The variant must belong to (storeId, productId): a mismatched
 * variantId is classified 404 VARIANT_NOT_FOUND, same as a product that
 * doesn't exist in the tenant.
 *
 * ISOLATION MODEL (documented, per the phase spec)
 * -----------------------------------------------
 * The decrement is an atomic conditional UPDATE:
 *
 *   UPDATE "BranchStock"
 *   SET "quantity" = "quantity" + $change
 *   WHERE branch_id = $branch AND product_id = $product
 *     AND store_id = $store [AND variant_id = $variant]
 *     AND "quantity" >= -$change        -- decrements only; restocks skip
 *                                       -- this guard (restocking at zero
 *                                       -- stock must be legal)
 *
 * Postgres evaluates the WHERE clause against the row under the row lock
 * taken by the UPDATE itself, so two transactions that each pass the
 * check individually can never BOTH commit a combined over-sale:
 * whichever commits first wins; the second one's UPDATE blocks, then
 * re-evaluates its WHERE on the new committed value, matches zero rows,
 * and is rejected with INSUFFICIENT_STOCK — rolling back its whole
 * transaction including the ledger insert.
 *
 * READ COMMITTED is therefore sufficient. SERIALIZABLE would add
 * performance cost without extra safety, because there is no
 * read-modify-write cycle: the check and the write are one statement,
 * not two.
 *
 * REASON POLICY
 * -------------
 * SALE and INITIAL_STOCK are rejected by the public HTTP path
 * (recordStockChange), unconditionally. Sale movements originate only
 * inside the order-fulfillment transaction (recordSaleStockChanges);
 * initial-stock seeds only inside the product-create transaction
 * (recordInitialStockChanges). No code path may attribute a ledger
 * movement to a sale or a seed except those two — keeping SALE and
 * INITIAL_STOCK entries trustworthy for reconciliation.
 * ============================================================
 */

export interface RecordStockChangeInput {
  storeId: string;
  /** The branch whose stock moves — required on every movement. */
  branchId: string;
  productId: string;
  /** Mandatory when the product has variants — names the exact variant. */
  variantId?: string;
  quantityChange: number;
  reason: $Enums.StockReason;
  performedByStaffId?: string;
  /** Free-form pointer to the movement's source document (e.g. a PO id). */
  referenceId?: string;
}

export interface RecordStockChangeResult {
  product: { id: string; name: string; quantity: number };
  /** Present (post-movement quantity) only for variant adjustments. */
  variant: { id: string; name: string; quantity: number } | null;
  /** The branch's stock after the movement — the authoritative number. */
  branchStockAfter: number;
  ledgerEntry: {
    id: string;
    variantId: string | null;
    quantityChange: number;
    reason: $Enums.StockReason;
    referenceId: string | null;
    performedByStaffId: string | null;
    createdAt: Date;
  };
}

export interface RecordSaleStockChangeInput {
  storeId: string;
  /** The branch whose stock the sale decrements (the order's branch). */
  branchId: string;
  productId: string;
  /** Optional — null/absent means a variant-less product movement. */
  variantId?: string;
  /** Negative integer — sales only decrement. */
  quantityChange: number;
}

export interface RecordSaleStockChangeResult {
  productId: string;
  variantId: string | null;
  quantityChange: number;
  stockAfter: number;
}

export interface RecordInitialStockChangeInput {
  storeId: string;
  /** The branch the seed lands in (the store's default branch). */
  branchId: string;
  productId: string;
  /** Mandatory when the product has variants — names the exact variant. */
  variantId?: string;
  /** Positive integer — starting stock at creation. */
  quantityChange: number;
}

export interface TransferStockInput {
  productId: string;
  /** Optional — null/absent means a variant-less product movement. */
  variantId?: string;
  sourceBranchId: string;
  destinationBranchId: string;
  /** Positive integer — the amount that physically moves. */
  quantity: number;
  /** The acting staff member — recorded on both ledger legs and the activity entry. */
  performedByStaffId?: string;
}

export interface TransferStockResult {
  source: RecordStockChangeResult;
  destination: RecordStockChangeResult;
}

const SALE: $Enums.StockReason = "SALE";

const INITIAL_STOCK: $Enums.StockReason = "INITIAL_STOCK";

const TRANSFER_OUT: $Enums.StockReason = "TRANSFER_OUT";

const TRANSFER_IN: $Enums.StockReason = "TRANSFER_IN";

const MANUAL_STOCK_REASONS: ReadonlySet<$Enums.StockReason> = new Set([
  "MANUAL_ADJUSTMENT",
  "RESTOCK",
  "REFUND",
  "WRITE_OFF",
]);

const RESTOCK: $Enums.StockReason = "RESTOCK";

export interface RecordPurchaseReceiptStockChangeInput {
  storeId: string;
  /** The branch the received goods land in (the order's branch). */
  branchId: string;
  productId: string;
  /** Optional — null/absent means a variant-less product movement. */
  variantId?: string;
  /** Positive integer — the received quantity. */
  quantityChange: number;
  /** The acting staff member — recorded on the ledger row and activity entry. */
  performedByStaffId?: string;
  /** The purchase-order id — the source document of this movement. */
  referenceId: string;
}

/**
 * The purchase-order receiving path: records RESTOCK movements inside
 * the CALLER's transaction — the PO receipt transaction — so the
 * receipt ledger rows, the line-item advances, and the stock movements
 * commit or roll back together. referenceId carries the purchase-order
 * id onto every ledger row (the movement's source document, per the
 * StockLedgerEntry contract). Never used by HTTP endpoints directly:
 * the public HTTP path (recordStockChange) also accepts RESTOCK, but
 * only this entry point can attribute a RESTOCK to a purchase order.
 */
export async function recordPurchaseReceiptStockChanges(
  tx: Prisma.TransactionClient,
  inputs: RecordPurchaseReceiptStockChangeInput[],
): Promise<RecordSaleStockChangeResult[]> {
  const results: RecordSaleStockChangeResult[] = [];
  for (const input of inputs) {
    if (!Number.isInteger(input.quantityChange) || input.quantityChange <= 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Quantity change must be a positive whole number for a receipt",
      );
    }
    if (typeof input.referenceId !== "string" || input.referenceId.length === 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "referenceId must be a non-empty string identifying the purchase order",
      );
    }
    const result = await applyStockChange(tx, {
      storeId: input.storeId,
      branchId: input.branchId,
      productId: input.productId,
      variantId: input.variantId,
      quantityChange: input.quantityChange,
      reason: RESTOCK,
      performedByStaffId: input.performedByStaffId,
      referenceId: input.referenceId,
    });
    results.push({
      productId: input.productId,
      variantId: input.variantId ?? null,
      quantityChange: input.quantityChange,
      stockAfter: result.branchStockAfter,
    });
  }
  return results;
}

/**
 * A row-level create on BranchStock has exactly one unique constraint it
 * can violate — the (branch, product[, variant]) uniqueness — so ANY
 * P2002 on create means a concurrent first-movement already created the
 * row. (The candidates are column/constraint names, so a field name
 * cannot match them; hence this looser check, scoped to this one call.)
 */
function isUniqueViolationAny(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === "P2002";
}

/**
 * Makes sure a (branch, product, variant) BranchStock row exists so an
 * INCREMENT can land on it (restock / transfer-in into a branch that
 * was created after the product, or a manual data fix). The partial
 * unique indexes backstop the find-then-create race: a concurrent
 * first-movement that both miss the findFirst loses the create on
 * P2002 and falls through to the retried update.
 */
async function ensureBranchStockRow(
  tx: Prisma.TransactionClient,
  args: { storeId: string; branchId: string; productId: string; variantId: string | null },
): Promise<void> {
  const existing = await tx.branchStock.findFirst({
    where: {
      branchId: args.branchId,
      productId: args.productId,
      storeId: args.storeId,
      variantId: args.variantId,
    },
  });
  if (existing !== null) return;
  try {
    await tx.branchStock.create({
      data: { ...args, quantity: 0 },
    });
  } catch (err) {
    if (!isUniqueViolationAny(err)) throw err;
  }
}

/**
 * The shared core of every stock movement: 404 classification pre-checks
 * (branch, product, and variant when named), the atomic conditional
 * UPDATE on the branch's BranchStock row (the isolation authority), the
 * cached-total updates, the ledger insert, and the read-backs — all on
 * the CALLER's transaction. Returns the recorded ledger entry and the
 * post-movement product (and variant when a variant was targeted) plus
 * the authoritative per-branch stock.
 */
async function applyStockChange(
  tx: Prisma.TransactionClient,
  input: RecordStockChangeInput,
): Promise<RecordStockChangeResult> {
  const {
    storeId,
    branchId,
    productId,
    variantId,
    quantityChange,
    reason,
    performedByStaffId,
    referenceId,
  } = input;

  // Classification pre-checks only (404 vs 409). The conditional
  // UPDATE below is the real authority and the only thing that can
  // race — the check cannot stale-guard it because the UPDATE's own
  // WHERE re-evaluates on the locked row.
  const branch = await tx.branch.findFirst({
    where: { id: branchId, storeId },
    select: { id: true, name: true },
  });
  if (branch === null) {
    throw new AppError(404, "BRANCH_NOT_FOUND", "Branch not found");
  }

  const existing = await tx.product.findUnique({
    where: { id: productId },
    select: { storeId: true, deletedAt: true },
  });
  if (existing === null || existing.storeId !== storeId || existing.deletedAt !== null) {
    throw new AppError(404, "NOT_FOUND", "Product not found");
  }

  // Resolve the movement target. A named variant must exist AND belong
  // to this (storeId, productId) — anything else is 404, mirroring the
  // product classification. When no variant is named, the product must
  // not have variants: per-variant stock is the only truth there, so a
  // product-level movement would corrupt the model.
  let variant: { id: string; name: string; quantity: number } | null = null;
  if (variantId !== undefined) {
    const found = await tx.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true, name: true, productId: true, storeId: true },
    });
    if (found === null || found.storeId !== storeId || found.productId !== productId) {
      throw new AppError(404, "VARIANT_NOT_FOUND", "Variant not found");
    }

    // For decrements the guard is `quantity >= -change` (e.g. a -5 change
    // requires stock >= 5), so the UPDATE can never drive the quantity
    // below zero — the DB CHECK exists as a backstop, not the first line.
    // Restocks (+change) have no guard: restocking at zero stock is legal.
    const stockGuard = quantityChange < 0 ? { quantity: { gte: -quantityChange } } : {};
    const updated = await tx.branchStock.updateMany({
      where: {
        branchId,
        productId,
        storeId,
        variantId: found.id,
        ...stockGuard,
      },
      data: { quantity: { increment: quantityChange } },
    });
    if (updated.count === 0) {
      if (quantityChange >= 0) {
        // The row is missing (branch created after the product, or a
        // manual fix) — create it, then retry the increment unguarded.
        await ensureBranchStockRow(tx, {
          storeId,
          branchId,
          productId,
          variantId: found.id,
        });
        const retried = await tx.branchStock.updateMany({
          where: { branchId, productId, storeId, variantId: found.id },
          data: { quantity: { increment: quantityChange } },
        });
        if (retried.count === 0) {
          throw new AppError(
            500,
            "STOCK_LEDGER_INCONSISTENCY",
            "Branch stock row missing — refusing to write a ledger entry",
          );
        }
      } else {
        throw new AppError(409, "INSUFFICIENT_STOCK", "Not enough stock for this adjustment");
      }
    }
  } else {
    const variantCount = await tx.productVariant.count({ where: { productId } });
    if (variantCount > 0) {
      throw new AppError(
        400,
        "VARIANT_REQUIRED",
        "This product has variants — stock must be adjusted per variant",
      );
    }

    const stockGuard = quantityChange < 0 ? { quantity: { gte: -quantityChange } } : {};
    const updated = await tx.branchStock.updateMany({
      where: {
        branchId,
        productId,
        storeId,
        variantId: null,
        ...stockGuard,
      },
      data: { quantity: { increment: quantityChange } },
    });
    if (updated.count === 0) {
      if (quantityChange >= 0) {
        await ensureBranchStockRow(tx, {
          storeId,
          branchId,
          productId,
          variantId: null,
        });
        const retried = await tx.branchStock.updateMany({
          where: { branchId, productId, storeId, variantId: null },
          data: { quantity: { increment: quantityChange } },
        });
        if (retried.count === 0) {
          throw new AppError(
            500,
            "STOCK_LEDGER_INCONSISTENCY",
            "Branch stock row missing — refusing to write a ledger entry",
          );
        }
      } else {
        throw new AppError(409, "INSUFFICIENT_STOCK", "Not enough stock for this adjustment");
      }
    }
  }

  // Cached CROSS-BRANCH totals. Unguarded on purpose: the BranchStock
  // row is the authority — the total is derived state that must never
  // block a movement (a transfer's +q and -q legs cancel out anyway).
  if (variantId !== undefined) {
    await tx.productVariant.updateMany({
      where: { id: variantId, productId, storeId },
      data: { quantity: { increment: quantityChange } },
    });
  } else {
    await tx.product.updateMany({
      where: { id: productId, storeId, deletedAt: null },
      data: { quantity: { increment: quantityChange } },
    });
  }

  // Post-movement read-back: must run AFTER the totals update, so the
  // served quantity reflects the movement (not the stale pre-update row).
  if (variantId !== undefined) {
    variant = await tx.productVariant.findUniqueOrThrow({
      where: { id: variantId },
      select: { id: true, name: true, quantity: true },
    });
  }

  const ledgerEntry = await tx.stockLedgerEntry.create({
    data: {
      storeId,
      branchId,
      productId,
      variantId: variant?.id ?? null,
      quantityChange,
      reason,
      referenceId: referenceId ?? null,
      performedByStaffId: performedByStaffId ?? null,
    },
  });
  const product = await tx.product.findUniqueOrThrow({
    where: { id: productId },
    select: { id: true, name: true, quantity: true },
  });
  const branchStock = await tx.branchStock.findFirstOrThrow({
    where: { branchId, productId, storeId, variantId: variant?.id ?? null },
    select: { quantity: true },
  });
  // The activity entry is written INSIDE the caller's transaction, so a
  // rolled-back movement leaves no orphan log row. SALE movements record
  // no staff member (they originate from webhooks, not the dashboard).
  await tx.storeActivityLog.create({
    data: {
      storeId,
      staffMemberId: performedByStaffId ?? null,
      action: reason === SALE ? "stock.sale" : "stock.adjusted",
      detail: {
        productId,
        productName: product.name,
        branchId,
        branchName: branch.name,
        variantId: variant?.id ?? null,
        variantName: variant?.name ?? null,
        quantityChange,
        reason,
      } as Prisma.InputJsonValue,
    },
  });
  return { product, variant, branchStockAfter: branchStock.quantity, ledgerEntry };
}

export async function recordStockChange(
  input: RecordStockChangeInput,
): Promise<RecordStockChangeResult> {
  const { quantityChange, reason, variantId, branchId } = input;

  if (typeof branchId !== "string" || branchId.length === 0) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "branchId must be a non-empty string identifying the movement's branch",
    );
  }
  if (variantId !== undefined && (typeof variantId !== "string" || variantId.length === 0)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "variantId must be a non-empty string when provided",
    );
  }
  if (!Number.isInteger(quantityChange) || quantityChange === 0) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Quantity change must be a whole number other than zero",
    );
  }
  if (reason === SALE) {
    throw new AppError(
      400,
      "INVALID_STOCK_REASON",
      "SALE stock movements originate only from order fulfillment",
    );
  }
  if (reason === INITIAL_STOCK) {
    throw new AppError(
      400,
      "INVALID_STOCK_REASON",
      "INITIAL_STOCK movements originate only from product creation",
    );
  }
  if (!MANUAL_STOCK_REASONS.has(reason)) {
    throw new AppError(400, "VALIDATION_ERROR", "Unknown stock reason");
  }

  const prisma = getPrismaClient();
  return prisma.$transaction((tx) => applyStockChange(tx, input));
}

/**
 * The product-creation path for starting stock: records INITIAL_STOCK
 * movements INSIDE the caller's transaction (the product-create
 * transaction), so the seed entries and the product row commit or roll
 * back together. Never used by HTTP endpoints directly — the public
 * path (recordStockChange) rejects INITIAL_STOCK reasons, so seed
 * entries can only originate here, in the create transaction.
 *
 * Each movement goes through applyStockChange, so the same disciplines
 * hold: the atomic conditional UPDATE sets the branch's cached
 * quantity, and the ledger row carries reason INITIAL_STOCK.
 */
export async function recordInitialStockChanges(
  tx: Prisma.TransactionClient,
  inputs: RecordInitialStockChangeInput[],
): Promise<RecordSaleStockChangeResult[]> {
  const results: RecordSaleStockChangeResult[] = [];
  for (const input of inputs) {
    if (!Number.isInteger(input.quantityChange) || input.quantityChange <= 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Quantity change must be a positive whole number for an initial stock entry",
      );
    }
    const result = await applyStockChange(tx, {
      ...input,
      reason: INITIAL_STOCK,
    });
    results.push({
      productId: input.productId,
      variantId: input.variantId ?? null,
      quantityChange: input.quantityChange,
      stockAfter: result.branchStockAfter,
    });
  }
  return results;
}

/**
 * The payment-confirmation path (webhook): records SALE movements inside
 * the CALLER's transaction — the webhook transaction. Never used by HTTP
 * endpoints directly; the public HTTP path (recordStockChange) rejects
 * SALE reasons, so SALE entries stay trustworthy for order
 * reconciliation.
 *
 * Duplicate productIds are aggregated into one movement. The caller owns
 * atomicity: if any item is rejected (INSUFFICIENT_STOCK rolls back the
 * conditional UPDATE), the caller's transaction must roll back too.
 */
export async function recordSaleStockChanges(
  tx: Prisma.TransactionClient,
  inputs: RecordSaleStockChangeInput[],
): Promise<RecordSaleStockChangeResult[]> {
  // Aggregation key is (productId, variantId): two line items of the
  // same variant combine into one movement, but two DIFFERENT variants
  // of the same product stay separate — each targets its own stock.
  // branchId is uniform within a call (one order = one branch) and is
  // carried through verbatim.
  const aggregated = new Map<
    string,
    {
      storeId: string;
      branchId: string;
      productId: string;
      variantId: string | null;
      quantityChange: number;
    }
  >();
  for (const input of inputs) {
    const { storeId, branchId, productId, variantId, quantityChange } = input;
    if (!Number.isInteger(quantityChange) || quantityChange >= 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Quantity change must be a negative whole number for a sale",
      );
    }
    if (typeof branchId !== "string" || branchId.length === 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "branchId must be a non-empty string identifying the movement's branch",
      );
    }
    const key = `${productId}:${variantId ?? ""}`;
    const entry = aggregated.get(key) ?? {
      storeId,
      branchId,
      productId,
      variantId: variantId ?? null,
      quantityChange: 0,
    };
    entry.quantityChange += quantityChange;
    aggregated.set(key, entry);
  }

  const results: RecordSaleStockChangeResult[] = [];
  for (const { storeId, branchId, productId, variantId, quantityChange } of aggregated.values()) {
    const result = await applyStockChange(tx, {
      storeId,
      branchId,
      productId,
      variantId: variantId ?? undefined,
      quantityChange,
      reason: SALE,
    });
    results.push({
      productId,
      variantId,
      quantityChange,
      stockAfter: result.branchStockAfter,
    });
  }
  return results;
}

/**
 * The branch-to-branch stock movement (doc flow 4.6): the source branch
 * decrements (TRANSFER_OUT), the destination increments (TRANSFER_IN),
 * both ledger rows in ONE transaction with the activity entry. The
 * cached cross-branch totals move +q on one leg and -q on the other —
 * net zero, so the product total never changes.
 *
 * Both branches must belong to the store (404) and be distinct (400).
 * Decrements are guarded by the same conditional UPDATE as every other
 * movement: an insufficient source branch fails atomically.
 */
export async function transferStock(
  storeId: string,
  input: TransferStockInput,
): Promise<TransferStockResult> {
  const {
    productId,
    variantId,
    sourceBranchId,
    destinationBranchId,
    quantity,
    performedByStaffId,
  } = input;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "quantity must be a positive integer for a transfer",
    );
  }
  if (typeof sourceBranchId !== "string" || sourceBranchId.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "Source branch is required");
  }
  if (typeof destinationBranchId !== "string" || destinationBranchId.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "Destination branch is required");
  }
  if (sourceBranchId === destinationBranchId) {
    throw new AppError(
      400,
      "TRANSFER_SAME_BRANCH",
      "Source and destination branch must be different",
    );
  }

  const prisma = getPrismaClient();
  return prisma.$transaction(async (tx) => {
    const sourceBranch = await tx.branch.findFirst({
      where: { id: sourceBranchId, storeId },
      select: { id: true },
    });
    if (sourceBranch === null) {
      throw new AppError(404, "BRANCH_NOT_FOUND", "Source branch not found");
    }
    const destinationBranch = await tx.branch.findFirst({
      where: { id: destinationBranchId, storeId },
      select: { id: true },
    });
    if (destinationBranch === null) {
      throw new AppError(404, "BRANCH_NOT_FOUND", "Destination branch not found");
    }

    // Decrement FIRST: an insufficient source branch fails the whole
    // transaction before the destination is touched.
    const source = await applyStockChange(tx, {
      storeId,
      branchId: sourceBranchId,
      productId,
      variantId,
      quantityChange: -quantity,
      reason: TRANSFER_OUT,
      performedByStaffId,
    });
    const destination = await applyStockChange(tx, {
      storeId,
      branchId: destinationBranchId,
      productId,
      variantId,
      quantityChange: quantity,
      reason: TRANSFER_IN,
      performedByStaffId,
    });
    return { source, destination };
  });
}
