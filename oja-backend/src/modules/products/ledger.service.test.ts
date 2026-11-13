import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import type { Prisma as PrismaNs, PrismaClient } from "../../../generated/prisma/client.js";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

import {
  recordInitialStockChanges,
  recordSaleStockChanges,
  recordStockChange,
  transferStock,
} from "./ledger.service.js";

type Mock = ReturnType<typeof vi.fn>;

interface TxStub {
  branch: { findFirst: Mock };
  product: { findUnique: Mock; updateMany: Mock; findUniqueOrThrow: Mock };
  productVariant: { findUnique: Mock; updateMany: Mock; findUniqueOrThrow: Mock; count: Mock };
  branchStock: { updateMany: Mock; findFirst: Mock; findFirstOrThrow: Mock; create: Mock };
  stockLedgerEntry: { create: Mock };
  storeActivityLog: { create: Mock };
}

const STORE_ID = "store-1";
const PRODUCT_ID = "product-1";
const VARIANT_ID = "variant-1";
const BRANCH_ID = "branch-1";
const OTHER_BRANCH_ID = "branch-2";

function createTxStub(): TxStub {
  return {
    branch: { findFirst: vi.fn().mockResolvedValue({ id: BRANCH_ID, name: "Main Branch" }) },
    product: { findUnique: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    productVariant: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    // The row is missing by default — the ensure-on-restock path must
    // prove itself before any test that needs a row resolves it.
    branchStock: {
      updateMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      findFirstOrThrow: vi.fn().mockResolvedValue({ quantity: 0 }),
      create: vi.fn().mockResolvedValue({ id: "bs-1", quantity: 0 }),
    },
    stockLedgerEntry: { create: vi.fn() },
    storeActivityLog: { create: vi.fn() },
  };
}

let tx: TxStub;
let $transaction: Mock;

beforeEach(() => {
  tx = createTxStub();
  $transaction = vi.fn(async (fn: (t: TxStub) => Promise<unknown>) => fn(tx));
  prismaMocks.getPrismaClient.mockReturnValue({
    $transaction,
  } as unknown as PrismaClient);
});

/** Variant-less product pre-checks: branch + product exist and belong. */
function productExists() {
  tx.product.findUnique.mockResolvedValue({
    id: PRODUCT_ID,
    storeId: STORE_ID,
    deletedAt: null,
    quantity: 10,
  });
}

/** The guarded movement lands; all read-backs resolve. */
function branchRowExists(quantityAfter: number) {
  tx.branchStock.updateMany.mockResolvedValue({ count: 1 });
  tx.branchStock.findFirstOrThrow.mockResolvedValue({ quantity: quantityAfter });
}

function ledgerResolves(overrides: Record<string, unknown> = {}) {
  tx.stockLedgerEntry.create.mockResolvedValue({
    id: "ledger-1",
    quantityChange: -4,
    reason: "MANUAL_ADJUSTMENT",
    referenceId: null,
    performedByStaffId: null,
    ...overrides,
  });
}

describe("recordStockChange (unit)", () => {
  it("applies an atomic conditional decrement on the branch's stock row and appends one ledger entry", async () => {
    productExists();
    branchRowExists(6);
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "Ground Coffee 500g",
      quantity: 6,
    });
    ledgerResolves({ id: "ledger-1", performedByStaffId: "staff-1" });

    const result = await recordStockChange({
      storeId: STORE_ID,
      branchId: BRANCH_ID,
      productId: PRODUCT_ID,
      quantityChange: -4,
      reason: "MANUAL_ADJUSTMENT",
      performedByStaffId: "staff-1",
    });

    // The conditional UPDATE is the isolation authority: the WHERE clause
    // re-evaluates on the locked row, so two concurrent over-selling
    // decrements cannot both pass. The guard lives on the BranchStock row
    // (variantId: null = the variant-less product's row).
    expect(tx.branchStock.updateMany).toHaveBeenCalledWith({
      where: {
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        storeId: STORE_ID,
        variantId: null,
        quantity: { gte: 4 },
      },
      data: { quantity: { increment: -4 } },
    });
    // The product-level total is a cross-branch cache — updated, but
    // unguarded (the branch row is the authority).
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: PRODUCT_ID, storeId: STORE_ID, deletedAt: null },
      data: { quantity: { increment: -4 } },
    });
    expect(tx.stockLedgerEntry.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        variantId: null,
        quantityChange: -4,
        reason: "MANUAL_ADJUSTMENT",
        performedByStaffId: "staff-1",
        referenceId: null,
      },
    });
    expect($transaction).toHaveBeenCalledOnce();
    expect(result.branchStockAfter).toBe(6);
    expect(result.product.quantity).toBe(6);
    expect(result.ledgerEntry.quantityChange).toBe(-4);
    expect(result.variant).toBeNull();
  });

  it("stores a positive restock with performedByStaffId null for owners", async () => {
    productExists();
    branchRowExists(16);
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "Honey 250g",
      quantity: 16,
    });
    ledgerResolves({ id: "ledger-2", quantityChange: 10, reason: "RESTOCK" });

    const result = await recordStockChange({
      storeId: STORE_ID,
      branchId: BRANCH_ID,
      productId: PRODUCT_ID,
      quantityChange: 10,
      reason: "RESTOCK",
    });

    // Restocks carry no quantity guard: restocking at zero stock is legal.
    expect(tx.branchStock.updateMany).toHaveBeenCalledWith({
      where: { branchId: BRANCH_ID, productId: PRODUCT_ID, storeId: STORE_ID, variantId: null },
      data: { quantity: { increment: 10 } },
    });
    expect(result.branchStockAfter).toBe(16);
    expect(result.product.quantity).toBe(16);
  });

  it("creates the BranchStock row on demand when a restock hits zero rows (branch created after the product)", async () => {
    productExists();
    // First attempt matches zero rows (row missing), the ensure path
    // creates it, the retried increment lands.
    tx.branchStock.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    tx.branchStock.findFirst.mockResolvedValueOnce(null);
    tx.branchStock.findFirstOrThrow.mockResolvedValue({ quantity: 15 });
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "Honey 250g",
      quantity: 15,
    });
    ledgerResolves({ id: "ledger-2", quantityChange: 15, reason: "RESTOCK" });

    const result = await recordStockChange({
      storeId: STORE_ID,
      branchId: BRANCH_ID,
      productId: PRODUCT_ID,
      quantityChange: 15,
      reason: "RESTOCK",
    });

    expect(tx.branchStock.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        variantId: null,
        quantity: 0,
      },
    });
    expect(tx.branchStock.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.stockLedgerEntry.create).toHaveBeenCalledTimes(1);
    expect(result.branchStockAfter).toBe(15);
  });

  it("treats a concurrent row-creation as a no-op and retries the increment (partial-index race)", async () => {
    productExists();
    tx.branchStock.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    // The other transaction created the row between our findFirst and
    // create — our create loses on the partial unique index.
    tx.branchStock.findFirst.mockResolvedValueOnce(null);
    tx.branchStock.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "7.9.1",
        meta: { target: ["branchId", "productId"] },
      }),
    );
    tx.branchStock.findFirstOrThrow.mockResolvedValue({ quantity: 15 });
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "Honey 250g",
      quantity: 15,
    });
    ledgerResolves({ id: "ledger-2", quantityChange: 15, reason: "RESTOCK" });

    await expect(
      recordStockChange({
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        quantityChange: 15,
        reason: "RESTOCK",
      }),
    ).resolves.toMatchObject({ branchStockAfter: 15 });
    expect(tx.stockLedgerEntry.create).toHaveBeenCalledTimes(1);
  });

  it("throws 404 when the branch is unknown or belongs to another store", async () => {
    tx.branch.findFirst.mockResolvedValue(null);

    await expect(
      recordStockChange({
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        quantityChange: -1,
        reason: "MANUAL_ADJUSTMENT",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BRANCH_NOT_FOUND" });
    expect(tx.product.findUnique).not.toHaveBeenCalled();
    expect(tx.branchStock.updateMany).not.toHaveBeenCalled();
  });

  it("throws 404 when the product is missing, cross-tenant, or soft-deleted", async () => {
    tx.product.findUnique.mockResolvedValue(null);
    await expect(
      recordStockChange({
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: "product-ghost",
        quantityChange: -1,
        reason: "MANUAL_ADJUSTMENT",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    expect(tx.branchStock.updateMany).not.toHaveBeenCalled();
  });

  it("adjusts a variant's stock: conditional update on the variant's branch row, ledger row carries variantId", async () => {
    productExists();
    tx.productVariant.findUnique.mockResolvedValue({
      id: VARIANT_ID,
      name: "Red - Large",
      productId: PRODUCT_ID,
      storeId: STORE_ID,
    });
    branchRowExists(6);
    tx.productVariant.findUniqueOrThrow.mockResolvedValue({
      id: VARIANT_ID,
      name: "Red - Large",
      quantity: 6,
    });
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "T-Shirt",
      quantity: 10,
    });
    ledgerResolves({ id: "ledger-var-1", variantId: VARIANT_ID });

    const result = await recordStockChange({
      storeId: STORE_ID,
      branchId: BRANCH_ID,
      productId: PRODUCT_ID,
      variantId: VARIANT_ID,
      quantityChange: -4,
      reason: "MANUAL_ADJUSTMENT",
    });

    // The variant's BranchStock row is the movement target — same atomic
    // conditional-update contract as the variant-less case.
    expect(tx.branchStock.updateMany).toHaveBeenCalledWith({
      where: {
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        storeId: STORE_ID,
        variantId: VARIANT_ID,
        quantity: { gte: 4 },
      },
      data: { quantity: { increment: -4 } },
    });
    // The variant's cached total is the cross-branch cache (unguarded);
    // the product-level counter is untouched.
    expect(tx.productVariant.updateMany).toHaveBeenCalledWith({
      where: { id: VARIANT_ID, productId: PRODUCT_ID, storeId: STORE_ID },
      data: { quantity: { increment: -4 } },
    });
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(tx.stockLedgerEntry.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityChange: -4,
        reason: "MANUAL_ADJUSTMENT",
        performedByStaffId: null,
        referenceId: null,
      },
    });
    expect(result.branchStockAfter).toBe(6);
    expect(result.product.quantity).toBe(10);
    expect(result.variant).toMatchObject({ id: VARIANT_ID, quantity: 6 });
  });

  it("rejects a variantId that belongs to a different product (404 VARIANT_NOT_FOUND)", async () => {
    productExists();
    tx.productVariant.findUnique.mockResolvedValue({
      id: VARIANT_ID,
      name: "Other Product's Variant",
      productId: "product-other",
      storeId: STORE_ID,
    });

    await expect(
      recordStockChange({
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityChange: -1,
        reason: "MANUAL_ADJUSTMENT",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "VARIANT_NOT_FOUND" });
    expect(tx.branchStock.updateMany).not.toHaveBeenCalled();
    expect(tx.stockLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("rejects a variantId from another store (404 VARIANT_NOT_FOUND)", async () => {
    productExists();
    tx.productVariant.findUnique.mockResolvedValue({
      id: VARIANT_ID,
      name: "Foreign",
      productId: PRODUCT_ID,
      storeId: "store-2",
    });

    await expect(
      recordStockChange({
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityChange: -1,
        reason: "MANUAL_ADJUSTMENT",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "VARIANT_NOT_FOUND" });
    expect(tx.branchStock.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a missing variantId when the product has variants (400 VARIANT_REQUIRED)", async () => {
    productExists();
    tx.productVariant.count.mockResolvedValue(2);

    await expect(
      recordStockChange({
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        quantityChange: -1,
        reason: "MANUAL_ADJUSTMENT",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VARIANT_REQUIRED" });
    expect(tx.branchStock.updateMany).not.toHaveBeenCalled();
    expect(tx.stockLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("throws 409 INSUFFICIENT_STOCK and writes nothing when the conditional update matches zero rows", async () => {
    productExists();
    tx.branchStock.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      recordStockChange({
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        quantityChange: -5,
        reason: "MANUAL_ADJUSTMENT",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "INSUFFICIENT_STOCK" });
    // Decrements never trigger the ensure path.
    expect(tx.branchStock.create).not.toHaveBeenCalled();
    expect(tx.stockLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("rejects a zero quantity change before touching the database", async () => {
    await expect(
      recordStockChange({
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        quantityChange: 0,
        reason: "MANUAL_ADJUSTMENT",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(tx.product.findUnique).not.toHaveBeenCalled();
  });

  it("rejects non-integer quantity changes", async () => {
    await expect(
      recordStockChange({
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        quantityChange: 2.5,
        reason: "MANUAL_ADJUSTMENT",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(tx.product.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a missing branchId before touching the database", async () => {
    await expect(
      recordStockChange({
        storeId: STORE_ID,
        branchId: "",
        productId: PRODUCT_ID,
        quantityChange: -1,
        reason: "MANUAL_ADJUSTMENT",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(tx.branch.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["SALE", "SALE is reserved for order fulfillment"],
    ["INITIAL_STOCK", "INITIAL_STOCK is reserved for product creation"],
    ["UNKNOWN_REASON", "unknown reason"],
  ])("rejects reason %s — %s", async (reason) => {
    await expect(
      recordStockChange({
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        quantityChange: -1,
        reason: reason as never,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: reason === "UNKNOWN_REASON" ? "VALIDATION_ERROR" : "INVALID_STOCK_REASON",
    });
    expect(tx.product.findUnique).not.toHaveBeenCalled();
  });
});

describe("recordSaleStockChanges (unit) — the internal payment-confirmation path", () => {
  it("decrements the order branch's stock and appends one SALE ledger entry per item, inside the CALLER'S transaction", async () => {
    productExists();
    branchRowExists(6);
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "Ground Coffee 500g",
      quantity: 6,
    });
    ledgerResolves({ id: "ledger-sale-1", quantityChange: -4, reason: "SALE" });

    const results = await recordSaleStockChanges(tx as never, [
      {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        quantityChange: -4,
      },
    ]);

    // Sale entries always use the SALE reason and never attribute a staff member.
    expect(tx.stockLedgerEntry.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        variantId: null,
        quantityChange: -4,
        reason: "SALE",
        performedByStaffId: null,
        referenceId: null,
      },
    });
    // Same atomic conditional UPDATE contract as recordStockChange.
    expect(tx.branchStock.updateMany).toHaveBeenCalledWith({
      where: {
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        storeId: STORE_ID,
        variantId: null,
        quantity: { gte: 4 },
      },
      data: { quantity: { increment: -4 } },
    });
    // The caller owns the transaction: the client's $transaction is never touched.
    expect($transaction).not.toHaveBeenCalled();
    expect(results).toEqual([
      { productId: PRODUCT_ID, variantId: null, quantityChange: -4, stockAfter: 6 },
    ]);
  });

  it("handles several line items in one call, including duplicate product aggregation", async () => {
    productExists();
    branchRowExists(3);
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "Honey 250g",
      quantity: 3,
    });
    ledgerResolves({ id: "ledger-sale-2", quantityChange: -7, reason: "SALE" });

    const results = await recordSaleStockChanges(tx as never, [
      { storeId: STORE_ID, branchId: BRANCH_ID, productId: PRODUCT_ID, quantityChange: -3 },
      { storeId: STORE_ID, branchId: BRANCH_ID, productId: PRODUCT_ID, quantityChange: -4 },
    ]);

    expect(results).toEqual([
      { productId: PRODUCT_ID, variantId: null, quantityChange: -7, stockAfter: 3 },
    ]);
    expect(tx.branchStock.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.stockLedgerEntry.create).toHaveBeenCalledTimes(1);
  });

  it("aggregates by (productId, variantId): two variants of one product stay separate", async () => {
    productExists();
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "T-Shirt",
      quantity: 10,
    });
    tx.productVariant.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        name: where.id === "variant-1" ? "Red - Large" : "Blue - Small",
        productId: PRODUCT_ID,
        storeId: STORE_ID,
      }),
    );
    tx.branchStock.updateMany.mockResolvedValue({ count: 1 });
    tx.branchStock.findFirstOrThrow.mockImplementation(
      async ({ where }: { where: { variantId: string | null } }) => ({
        quantity: where.variantId === VARIANT_ID ? 5 : 9,
      }),
    );
    tx.productVariant.findUniqueOrThrow.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        name: where.id === "variant-1" ? "Red - Large" : "Blue - Small",
        quantity: where.id === "variant-1" ? 5 : 9,
      }),
    );
    ledgerResolves({ id: "ledger-sale-var", quantityChange: -1, reason: "SALE" });

    const results = await recordSaleStockChanges(tx as never, [
      {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        variantId: "variant-1",
        quantityChange: -5,
      },
      {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        variantId: "variant-2",
        quantityChange: -1,
      },
    ]);

    // Two different variants of the same product = two movements, each
    // targeting its own variant's stock.
    expect(tx.branchStock.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.stockLedgerEntry.create).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { productId: PRODUCT_ID, variantId: "variant-1", quantityChange: -5, stockAfter: 5 },
      { productId: PRODUCT_ID, variantId: "variant-2", quantityChange: -1, stockAfter: 9 },
    ]);
  });

  it("rejects with 409 INSUFFICIENT_STOCK when the conditional update matches zero rows", async () => {
    productExists();
    tx.branchStock.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      recordSaleStockChanges(tx as never, [
        { storeId: STORE_ID, branchId: BRANCH_ID, productId: PRODUCT_ID, quantityChange: -5 },
      ]),
    ).rejects.toMatchObject({ statusCode: 409, code: "INSUFFICIENT_STOCK" });
    expect(tx.stockLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("throws 404 when the product is missing, cross-tenant, or soft-deleted", async () => {
    tx.product.findUnique.mockResolvedValue(null);

    await expect(
      recordSaleStockChanges(tx as never, [
        { storeId: STORE_ID, branchId: BRANCH_ID, productId: "product-ghost", quantityChange: -1 },
      ]),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    expect(tx.branchStock.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a non-negative quantity change — sales only decrement", async () => {
    await expect(
      recordSaleStockChanges(tx as never, [
        { storeId: STORE_ID, branchId: BRANCH_ID, productId: PRODUCT_ID, quantityChange: 1 },
      ]),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    await expect(
      recordSaleStockChanges(tx as never, [
        { storeId: STORE_ID, branchId: BRANCH_ID, productId: PRODUCT_ID, quantityChange: 0 },
      ]),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(tx.product.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a non-integer quantity change", async () => {
    await expect(
      recordSaleStockChanges(tx as never, [
        { storeId: STORE_ID, branchId: BRANCH_ID, productId: PRODUCT_ID, quantityChange: -1.5 },
      ]),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
  });

  it("rejects a missing branchId before touching the database", async () => {
    await expect(
      recordSaleStockChanges(tx as never, [
        { storeId: STORE_ID, branchId: "", productId: PRODUCT_ID, quantityChange: -1 },
      ]),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(tx.product.findUnique).not.toHaveBeenCalled();
  });

  it("returns an empty list for an empty input without touching the database (edge)", async () => {
    const results = await recordSaleStockChanges(tx as never, []);

    expect(results).toEqual([]);
    expect(tx.product.findUnique).not.toHaveBeenCalled();
    expect(tx.stockLedgerEntry.create).not.toHaveBeenCalled();
  });
});

describe("recordStockChange — INITIAL_STOCK policy (unit)", () => {
  it("rejects INITIAL_STOCK through the HTTP path (INVALID_STOCK_REASON)", async () => {
    productExists();

    await expect(
      recordStockChange({
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        quantityChange: 5,
        reason: "INITIAL_STOCK",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_STOCK_REASON" });
    expect(tx.branchStock.updateMany).not.toHaveBeenCalled();
    expect(tx.stockLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("passes referenceId through to the ledger entry", async () => {
    productExists();
    branchRowExists(30);
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "Ground Coffee 500g",
      quantity: 30,
    });
    ledgerResolves({
      id: "ledger-ref",
      quantityChange: 20,
      reason: "RESTOCK",
      referenceId: "po-123",
    });

    const result = await recordStockChange({
      storeId: STORE_ID,
      branchId: BRANCH_ID,
      productId: PRODUCT_ID,
      quantityChange: 20,
      reason: "RESTOCK",
      referenceId: "po-123",
    });

    expect(tx.stockLedgerEntry.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        variantId: null,
        quantityChange: 20,
        reason: "RESTOCK",
        referenceId: "po-123",
        performedByStaffId: null,
      },
    });
    expect(result.ledgerEntry.referenceId).toBe("po-123");
  });
});

describe("recordInitialStockChanges (unit) — the create-transaction seed path", () => {
  function seedSetup() {
    productExists();
    tx.productVariant.count.mockResolvedValue(0);
    branchRowExists(25);
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "Seeded",
      quantity: 25,
    });
    ledgerResolves({ id: "ledger-seed", quantityChange: 25, reason: "INITIAL_STOCK" });
  }

  it("seeds inside the CALLER's transaction: no own $transaction, one conditional update + one INITIAL_STOCK ledger row", async () => {
    seedSetup();

    const results = await recordInitialStockChanges(tx as unknown as PrismaNs.TransactionClient, [
      { storeId: STORE_ID, branchId: BRANCH_ID, productId: PRODUCT_ID, quantityChange: 25 },
    ]);

    // tx-scoped: the service must NOT open its own transaction.
    expect($transaction).not.toHaveBeenCalled();
    expect(tx.branchStock.updateMany).toHaveBeenCalledWith({
      where: { branchId: BRANCH_ID, productId: PRODUCT_ID, storeId: STORE_ID, variantId: null },
      data: { quantity: { increment: 25 } },
    });
    expect(tx.stockLedgerEntry.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        variantId: null,
        quantityChange: 25,
        reason: "INITIAL_STOCK",
        referenceId: null,
        performedByStaffId: null,
      },
    });
    expect(results).toEqual([
      { productId: PRODUCT_ID, variantId: null, quantityChange: 25, stockAfter: 25 },
    ]);
  });

  it("seeds each variant separately, naming the variant on every movement", async () => {
    productExists();
    tx.productVariant.count.mockResolvedValue(1);
    tx.productVariant.findUnique.mockResolvedValue({
      id: VARIANT_ID,
      name: "M",
      productId: PRODUCT_ID,
      storeId: STORE_ID,
    });
    tx.branchStock.updateMany.mockResolvedValue({ count: 1 });
    tx.branchStock.findFirstOrThrow.mockResolvedValue({ quantity: 10 });
    tx.productVariant.findUniqueOrThrow.mockResolvedValue({
      id: VARIANT_ID,
      name: "M",
      quantity: 10,
    });
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "Seeded Shirt",
      quantity: 0,
    });
    tx.stockLedgerEntry.create.mockResolvedValue({ id: "ledger-seed" });

    const results = await recordInitialStockChanges(tx as unknown as PrismaNs.TransactionClient, [
      {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityChange: 10,
      },
      {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        quantityChange: 2,
      },
    ]);

    // Per-variant movements target the VARIANT's branch row; the
    // product's counter is untouched. Positive seeds carry no guard
    // (seeding at zero stock is legal).
    expect(tx.branchStock.updateMany).toHaveBeenCalledWith({
      where: {
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        storeId: STORE_ID,
        variantId: VARIANT_ID,
      },
      data: { quantity: { increment: 10 } },
    });
    expect(tx.branchStock.updateMany).toHaveBeenCalledWith({
      where: {
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        storeId: STORE_ID,
        variantId: VARIANT_ID,
      },
      data: { quantity: { increment: 2 } },
    });
    expect(tx.stockLedgerEntry.create).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { productId: PRODUCT_ID, variantId: VARIANT_ID, quantityChange: 10, stockAfter: 10 },
      { productId: PRODUCT_ID, variantId: VARIANT_ID, quantityChange: 2, stockAfter: 10 },
    ]);
  });

  it("rejects non-positive seeds before any write", async () => {
    await expect(
      recordInitialStockChanges(tx as unknown as PrismaNs.TransactionClient, [
        { storeId: STORE_ID, branchId: BRANCH_ID, productId: PRODUCT_ID, quantityChange: 0 },
      ]),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(tx.branchStock.updateMany).not.toHaveBeenCalled();
    expect(tx.stockLedgerEntry.create).not.toHaveBeenCalled();
  });
});

describe("transferStock (unit) — the branch-to-branch movement", () => {
  function branchesExist() {
    tx.branch.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === BRANCH_ID || where.id === OTHER_BRANCH_ID
        ? { id: where.id, name: where.id === BRANCH_ID ? "Main Branch" : "Warehouse" }
        : null,
    );
  }

  it("decrements the source branch (TRANSFER_OUT) and increments the destination (TRANSFER_IN) in ONE transaction", async () => {
    branchesExist();
    productExists();
    tx.productVariant.count.mockResolvedValue(0);
    tx.branchStock.updateMany.mockResolvedValue({ count: 1 });
    tx.branchStock.findFirstOrThrow.mockResolvedValue({ quantity: 3 });
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "Ground Coffee 500g",
      quantity: 7,
    });
    tx.stockLedgerEntry.create.mockResolvedValue({
      id: "ledger-transfer",
      quantityChange: 0,
      reason: "TRANSFER_OUT",
      referenceId: null,
      performedByStaffId: null,
    });

    const result = await transferStock(STORE_ID, {
      productId: PRODUCT_ID,
      sourceBranchId: BRANCH_ID,
      destinationBranchId: OTHER_BRANCH_ID,
      quantity: 4,
    });

    // Source leg: GUARDED decrement on the source branch's row.
    expect(tx.branchStock.updateMany).toHaveBeenCalledWith({
      where: {
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        storeId: STORE_ID,
        variantId: null,
        quantity: { gte: 4 },
      },
      data: { quantity: { increment: -4 } },
    });
    // Destination leg: unguarded increment on the destination's row.
    expect(tx.branchStock.updateMany).toHaveBeenCalledWith({
      where: {
        branchId: OTHER_BRANCH_ID,
        productId: PRODUCT_ID,
        storeId: STORE_ID,
        variantId: null,
      },
      data: { quantity: { increment: 4 } },
    });
    // Two ledger rows: TRANSFER_OUT then TRANSFER_IN.
    const ledgerCreates = tx.stockLedgerEntry.create.mock.calls.map(([arg]) => arg.data);
    expect(ledgerCreates.map((data: { reason: string }) => data.reason)).toEqual([
      "TRANSFER_OUT",
      "TRANSFER_IN",
    ]);
    expect(tx.stockLedgerEntry.create.mock.calls[0]![0].data).toMatchObject({
      branchId: BRANCH_ID,
      quantityChange: -4,
    });
    expect(tx.stockLedgerEntry.create.mock.calls[1]![0].data).toMatchObject({
      branchId: OTHER_BRANCH_ID,
      quantityChange: 4,
    });
    // One transaction owns both legs — partial failure is impossible.
    expect($transaction).toHaveBeenCalledOnce();
    expect(result.source.branchStockAfter).toBe(3);
    expect(result.destination.branchStockAfter).toBe(3);
  });

  it("records the performing staff member on both ledger legs", async () => {
    branchesExist();
    productExists();
    tx.productVariant.count.mockResolvedValue(0);
    tx.branchStock.updateMany.mockResolvedValue({ count: 1 });
    tx.branchStock.findFirstOrThrow.mockResolvedValue({ quantity: 3 });
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "Ground Coffee 500g",
      quantity: 7,
    });
    tx.stockLedgerEntry.create.mockResolvedValue({
      id: "ledger-transfer",
      quantityChange: 0,
      reason: "TRANSFER_OUT",
      referenceId: null,
      performedByStaffId: null,
    });

    await transferStock(STORE_ID, {
      productId: PRODUCT_ID,
      sourceBranchId: BRANCH_ID,
      destinationBranchId: OTHER_BRANCH_ID,
      quantity: 4,
      performedByStaffId: "staff-9",
    });

    const ledgerCreates = tx.stockLedgerEntry.create.mock.calls.map(([arg]) => arg.data);
    expect(
      ledgerCreates.map((data: { performedByStaffId: string | null }) => data.performedByStaffId),
    ).toEqual(["staff-9", "staff-9"]);
    const activityCreates = tx.storeActivityLog.create.mock.calls.map(([arg]) => arg.data);
    expect(
      activityCreates.map((data: { staffMemberId: string | null }) => data.staffMemberId),
    ).toEqual(["staff-9", "staff-9"]);
  });

  it("rejects with 409 INSUFFICIENT_STOCK when the source branch lacks the stock — destination untouched", async () => {
    branchesExist();
    productExists();
    tx.productVariant.count.mockResolvedValue(0);
    // The source decrement matches zero rows.
    tx.branchStock.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      transferStock(STORE_ID, {
        productId: PRODUCT_ID,
        sourceBranchId: BRANCH_ID,
        destinationBranchId: OTHER_BRANCH_ID,
        quantity: 5,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "INSUFFICIENT_STOCK" });
    expect(tx.branchStock.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.stockLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("rejects a source branch of another store (404 BRANCH_NOT_FOUND)", async () => {
    branchesExist();
    tx.branch.findFirst.mockResolvedValueOnce({ id: BRANCH_ID, name: "Main Branch" });
    tx.branch.findFirst.mockResolvedValueOnce(null);

    await expect(
      transferStock(STORE_ID, {
        productId: PRODUCT_ID,
        sourceBranchId: BRANCH_ID,
        destinationBranchId: OTHER_BRANCH_ID,
        quantity: 4,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BRANCH_NOT_FOUND" });
    expect(tx.branchStock.updateMany).not.toHaveBeenCalled();
  });

  it("rejects transferring to the same branch before touching the database (400 TRANSFER_SAME_BRANCH)", async () => {
    await expect(
      transferStock(STORE_ID, {
        productId: PRODUCT_ID,
        sourceBranchId: BRANCH_ID,
        destinationBranchId: BRANCH_ID,
        quantity: 4,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "TRANSFER_SAME_BRANCH" });
    expect($transaction).not.toHaveBeenCalled();
  });

  it("rejects non-positive quantities and empty ids before touching the database", async () => {
    await expect(
      transferStock(STORE_ID, {
        productId: PRODUCT_ID,
        sourceBranchId: BRANCH_ID,
        destinationBranchId: OTHER_BRANCH_ID,
        quantity: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    await expect(
      transferStock(STORE_ID, {
        productId: PRODUCT_ID,
        sourceBranchId: "",
        destinationBranchId: OTHER_BRANCH_ID,
        quantity: 4,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect($transaction).not.toHaveBeenCalled();
  });

  it("creates the destination row on demand when the branch is newer than the product (concurrent-create safe)", async () => {
    branchesExist();
    productExists();
    tx.productVariant.count.mockResolvedValue(0);
    // Source leg lands; destination leg hits zero rows first, then the
    // ensure path creates the row, then the retry lands.
    tx.branchStock.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    tx.branchStock.findFirst.mockResolvedValue(null);
    tx.branchStock.findFirstOrThrow.mockResolvedValue({ quantity: 4 });
    tx.product.findUniqueOrThrow.mockResolvedValue({
      id: PRODUCT_ID,
      name: "Ground Coffee 500g",
      quantity: 7,
    });
    tx.stockLedgerEntry.create.mockResolvedValue({
      id: "ledger-transfer",
      quantityChange: 0,
      reason: "TRANSFER_OUT",
      referenceId: null,
      performedByStaffId: null,
    });

    const result = await transferStock(STORE_ID, {
      productId: PRODUCT_ID,
      sourceBranchId: BRANCH_ID,
      destinationBranchId: OTHER_BRANCH_ID,
      quantity: 4,
    });

    expect(tx.branchStock.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        branchId: OTHER_BRANCH_ID,
        productId: PRODUCT_ID,
        variantId: null,
        quantity: 0,
      },
    });
    expect(tx.branchStock.updateMany).toHaveBeenCalledTimes(3);
    expect(tx.stockLedgerEntry.create).toHaveBeenCalledTimes(2);
    expect(result.destination.branchStockAfter).toBe(4);
  });
});
