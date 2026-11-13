import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";

// Prisma is stubbed at the module boundary, matching the products-service
// unit-test pattern; the ledger is mocked because its own suite covers
// applyStockChange — here we only assert the wiring (initialStock seeds
// are routed through recordInitialStockChanges).
const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));
const ledgerMocks = vi.hoisted(() => ({ recordInitialStockChanges: vi.fn() }));
vi.mock("./ledger.service.js", () => ({
  recordInitialStockChanges: ledgerMocks.recordInitialStockChanges,
}));

import { confirmBulkImport, startBulkImport } from "./bulk.service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  $transaction: Mock;
  store: { findUnique: Mock };
  subscription: { findUnique: Mock };
  storeActivityLog: { create: Mock };
  productImport: { findFirst: Mock; create: Mock; update: Mock };
  productImportRow: { update: Mock };
  category: { findMany: Mock };
  unit: { findMany: Mock };
  product: {
    findMany: Mock;
    create: Mock;
    updateMany: Mock;
    findUniqueOrThrow: Mock;
    count: Mock;
  };
  branchStock: { create: Mock };
}

function createStub(): PrismaStub {
  const stub: PrismaStub = {
    $transaction: vi.fn((cb: (tx: PrismaClient) => unknown) => cb(stub as unknown as PrismaClient)),
    store: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: STORE_ID, subscriptionId: null, defaultBranchId: BRANCH_ID }),
    },
    subscription: { findUnique: vi.fn().mockResolvedValue(null) },
    storeActivityLog: { create: vi.fn() },
    productImport: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "import-1", createdAt: new Date() }),
      update: vi.fn().mockResolvedValue({}),
    },
    productImportRow: { update: vi.fn().mockResolvedValue({}) },
    category: { findMany: vi.fn().mockResolvedValue([]) },
    unit: { findMany: vi.fn().mockResolvedValue([]) },
    product: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    branchStock: { create: vi.fn().mockResolvedValue({}) },
  };
  return stub;
}

function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    storeId: STORE_ID,
    tier: "STARTER",
    status: "ACTIVE",
    currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
    currentPeriodStart: new Date("2026-08-02T00:00:00Z"),
    staffCap: null,
    locationCap: null,
    productCap: null,
    orderCap: null,
    createdAt: new Date("2026-08-02T00:00:00Z"),
    updatedAt: new Date("2026-08-02T00:00:00Z"),
    ...overrides,
  };
}

const STORE_ID = "store-1";

const BRANCH_ID = "branch-1";

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-1",
    storeId: STORE_ID,
    name: "Ground Coffee 500g",
    price: "12.50",
    description: null,
    images: [],
    quantity: 0,
    deletedAt: null,
    variants: [],
    category: null,
    unit: null,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    ...overrides,
  };
}

function importRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    importId: "import-1",
    rowNumber: 1,
    name: "Cold Brew 500ml",
    price: "8.00",
    costPrice: null,
    description: null,
    images: [],
    coverImageUrl: null,
    categoryId: null,
    unitId: null,
    initialStock: null,
    status: "NEW",
    errors: [],
    existingProductId: null,
    createdProductId: null,
    overwrite: false,
    ...overrides,
  };
}

function importTicket(rows: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
  return {
    id: "import-1",
    storeId: STORE_ID,
    createdByStaffId: "staff-1",
    status: "PENDING",
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    confirmedAt: null,
    rows,
    ...overrides,
  };
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  ledgerMocks.recordInitialStockChanges.mockReset().mockResolvedValue([]);
});

describe("startBulkImport (unit)", () => {
  it("creates a ticket and returns per-row dispositions for valid input", async () => {
    stub.productImport.create.mockResolvedValue({ id: "import-1" });
    stub.category.findMany.mockResolvedValue([{ id: "cat-1" }]);
    stub.unit.findMany.mockResolvedValue([{ id: "unit-1" }]);

    const result = await startBulkImport(STORE_ID, "staff-1", {
      rows: [
        {
          name: "  Ground Coffee 500g  ",
          price: 12.5,
          costPrice: "3.25",
          description: "Single-origin",
          images: ["https://cdn.example.com/coffee.jpg"],
          categoryId: "cat-1",
          unitId: "unit-1",
          initialStock: 20,
        },
        { name: "Cold Brew", price: "8" },
      ],
    });

    expect(stub.productImport.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        createdByStaffId: "staff-1",
        status: "PENDING",
        expiresAt: expect.any(Date),
        rows: {
          create: [
            {
              rowNumber: 1,
              name: "Ground Coffee 500g",
              price: "12.50",
              costPrice: "3.25",
              description: "Single-origin",
              images: ["https://cdn.example.com/coffee.jpg"],
              coverImageUrl: null,
              categoryId: "cat-1",
              unitId: "unit-1",
              initialStock: 20,
              status: "NEW",
              errors: [],
            },
            {
              rowNumber: 2,
              name: "Cold Brew",
              price: "8.00",
              costPrice: null,
              description: null,
              images: [],
              coverImageUrl: null,
              categoryId: null,
              unitId: null,
              initialStock: null,
              status: "NEW",
              errors: [],
            },
          ],
        },
      },
    });
    expect(result.importId).toBe("import-1");
    expect(result.summary).toEqual({ new: 2, duplicates: 0, errors: 0 });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.status).toBe("new");
    expect(result.rows[0]!.product).toMatchObject({
      name: "Ground Coffee 500g",
      price: "12.50",
      costPrice: "3.25",
      initialStock: 20,
    });
    expect(result.rows[1]!.product).toMatchObject({ price: "8.00", costPrice: null });
    const expiresMs = Date.parse(result.expiresAt.toISOString());
    expect(expiresMs - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(expiresMs - Date.now()).toBeLessThan(25 * 60 * 60 * 1000);
  });

  it("flags rows missing name or price as errors without failing the valid rows", async () => {
    const result = await startBulkImport(STORE_ID, undefined, {
      rows: [
        { description: "no name or price" },
        { name: "  ", price: 5 },
        { name: "ok", price: 5 },
      ],
    });

    expect(result.summary).toEqual({ new: 1, duplicates: 0, errors: 2 });
    expect(result.rows[0]!.status).toBe("error");
    expect(result.rows[0]!.errors.length).toBeGreaterThan(0);
    expect(result.rows[1]!.status).toBe("error");
    expect(result.rows[1]!.errors).toContain("name is required");
    expect(result.rows[2]!.status).toBe("new");
    expect(result.rows[2]!.product?.name).toBe("ok");

    const created = stub.productImport.create.mock.calls[0]![0].data.rows.create;
    expect(created).toHaveLength(3);
    expect(created[0].status).toBe("ERROR");
    expect(created[0].errors.length).toBeGreaterThan(0);
  });

  it("flags a row that collides with an existing product (case-insensitive)", async () => {
    stub.product.findMany.mockResolvedValue([{ id: "p-1", name: "cold brew 500ml" }]);

    const result = await startBulkImport(STORE_ID, "staff-1", {
      rows: [{ name: "Cold Brew 500ml", price: 8 }],
    });

    expect(result.rows[0]).toMatchObject({
      status: "duplicate",
      existingProductId: "p-1",
      existingName: "cold brew 500ml",
      product: null,
    });
    expect(result.summary).toEqual({ new: 0, duplicates: 1, errors: 0 });
    const created = stub.productImport.create.mock.calls[0]![0].data.rows.create;
    expect(created[0].status).toBe("DUPLICATE");
    expect(created[0].existingProductId).toBe("p-1");
  });

  it("flags the later row of an intra-import name collision without an existing product", async () => {
    const result = await startBulkImport(STORE_ID, "staff-1", {
      rows: [
        { name: "Cafe", price: 3 },
        { name: "cafe", price: 4 },
      ],
    });

    expect(result.rows[0]!.status).toBe("new");
    expect(result.rows[1]).toMatchObject({
      status: "duplicate",
      existingProductId: null,
      existingName: "Cafe",
    });
    expect(result.summary).toEqual({ new: 1, duplicates: 1, errors: 0 });
  });

  it("flags rows referencing unknown or cross-tenant category/unit ids as errors", async () => {
    const result = await startBulkImport(STORE_ID, "staff-1", {
      rows: [
        { name: "Bad Refs", price: 5, categoryId: "other-store-cat", unitId: "other-store-unit" },
      ],
    });

    expect(result.rows[0]!.status).toBe("error");
    expect(result.rows[0]!.errors.some((e) => e.includes("categoryId"))).toBe(true);
    expect(result.rows[0]!.errors.some((e) => e.includes("unitId"))).toBe(true);
  });

  it("rejects an empty rows array and more than 500 rows", async () => {
    await expect(startBulkImport(STORE_ID, "staff-1", { rows: [] })).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
    const rows = Array.from({ length: 501 }, (_, i) => ({ name: `p-${i}`, price: 1 }));
    await expect(startBulkImport(STORE_ID, "staff-1", { rows })).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
    expect(stub.productImport.create).not.toHaveBeenCalled();
  });
});

describe("confirmBulkImport (unit)", () => {
  it("404s for an unknown, cross-tenant, expired, or already-confirmed ticket", async () => {
    stub.productImport.findFirst.mockResolvedValue(null);
    await expect(
      confirmBulkImport(STORE_ID, "staff-1", { importId: "import-x" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "IMPORT_NOT_FOUND" });

    stub.productImport.findFirst.mockResolvedValue(
      importTicket([importRow()], { storeId: "other-store" }),
    );
    await expect(
      confirmBulkImport(STORE_ID, "staff-1", { importId: "import-1" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "IMPORT_NOT_FOUND" });

    stub.productImport.findFirst.mockResolvedValue(
      importTicket([importRow()], { expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(
      confirmBulkImport(STORE_ID, "staff-1", { importId: "import-1" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "IMPORT_NOT_FOUND" });

    stub.productImport.findFirst.mockResolvedValue(
      importTicket([importRow()], { status: "CONFIRMED" }),
    );
    await expect(
      confirmBulkImport(STORE_ID, "staff-1", { importId: "import-1" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "IMPORT_NOT_FOUND" });
  });

  it("creates new rows with eager branch stock and INITIAL_STOCK seeds in one transaction", async () => {
    stub.productImport.findFirst.mockResolvedValue(
      importTicket([
        importRow({ name: "Cold Brew 500ml", initialStock: 5 }),
        importRow({ id: "row-2", rowNumber: 2, name: "Plain Tea" }),
      ]),
    );
    stub.product.create
      .mockResolvedValueOnce(productRow({ name: "Cold Brew 500ml" }))
      .mockResolvedValueOnce(productRow({ id: "product-2", name: "Plain Tea" }));

    const result = await confirmBulkImport(STORE_ID, "staff-1", { importId: "import-1" });

    expect(stub.product.create).toHaveBeenCalledTimes(2);
    expect(stub.product.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        name: "Cold Brew 500ml",
        price: "8.00",
        costPrice: null,
        description: null,
        images: [],
        coverImageUrl: null,
      },
      include: {
        variants: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        category: true,
        unit: true,
      },
    });
    expect(stub.branchStock.create).toHaveBeenCalledTimes(2);
    expect(stub.branchStock.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: "product-1",
        variantId: null,
        quantity: 0,
      },
    });
    expect(ledgerMocks.recordInitialStockChanges).toHaveBeenCalledWith(stub, [
      { storeId: STORE_ID, branchId: BRANCH_ID, productId: "product-1", quantityChange: 5 },
    ]);
    expect(result.created.map((p) => p.name)).toEqual(["Cold Brew 500ml", "Plain Tea"]);
    expect(result.failed).toEqual([]);
  });

  it("does not seed stock when no initialStock is provided", async () => {
    stub.productImport.findFirst.mockResolvedValue(
      importTicket([importRow({ name: "Plain Tea", initialStock: null })]),
    );
    stub.product.create.mockResolvedValue(productRow({ name: "Plain Tea" }));

    await confirmBulkImport(STORE_ID, "staff-1", { importId: "import-1" });

    expect(ledgerMocks.recordInitialStockChanges).not.toHaveBeenCalled();
  });

  it("overwrites an explicitly resolved duplicate and never touches stock", async () => {
    stub.productImport.findFirst.mockResolvedValue(
      importTicket([
        importRow({
          rowNumber: 1,
          status: "DUPLICATE",
          existingProductId: "p-existing",
          existingProductName: "Cold Brew 500ml",
          initialStock: 99,
        }),
      ]),
    );
    stub.product.updateMany.mockResolvedValue({ count: 1 });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow({ id: "p-existing" }));

    const result = await confirmBulkImport(STORE_ID, "staff-1", {
      importId: "import-1",
      resolveDuplicates: { "1": "overwrite" },
    });

    expect(stub.product.updateMany).toHaveBeenCalledWith({
      where: { id: "p-existing", storeId: STORE_ID, deletedAt: null },
      data: {
        name: "Cold Brew 500ml",
        price: "8.00",
        costPrice: null,
        description: null,
        images: [],
        coverImageUrl: null,
        categoryId: null,
        unitId: null,
      },
    });
    expect(stub.product.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ initialStock: expect.anything() }),
      }),
    );
    expect(stub.product.create).not.toHaveBeenCalled();
    expect(ledgerMocks.recordInitialStockChanges).not.toHaveBeenCalled();
    expect(result.overwritten.map((p) => p.id)).toEqual(["p-existing"]);
    expect(result.skipped).toEqual([]);
  });

  it("skips duplicates that are not resolved as overwrites", async () => {
    stub.productImport.findFirst.mockResolvedValue(
      importTicket([
        importRow({ rowNumber: 1, status: "DUPLICATE", existingProductId: "p-1", name: "A" }),
        importRow({ rowNumber: 2, status: "DUPLICATE", existingProductId: "p-2", name: "B" }),
      ]),
    );

    const result = await confirmBulkImport(STORE_ID, "staff-1", {
      importId: "import-1",
      resolveDuplicates: { "1": "skip" },
    });

    expect(stub.product.updateMany).not.toHaveBeenCalled();
    expect(stub.product.create).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([1, 2]);
  });

  it("400s when an error row or an unknown rowNumber is listed in resolveDuplicates", async () => {
    stub.productImport.findFirst.mockResolvedValue(
      importTicket([
        importRow({ rowNumber: 1, status: "ERROR", errors: ["bad"] }),
        importRow({ rowNumber: 2, status: "NEW", name: "B" }),
      ]),
    );
    await expect(
      confirmBulkImport(STORE_ID, "staff-1", {
        importId: "import-1",
        resolveDuplicates: { "1": "overwrite" },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });

    await expect(
      confirmBulkImport(STORE_ID, "staff-1", {
        importId: "import-1",
        resolveDuplicates: { "99": "skip" },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });

    await expect(
      confirmBulkImport(STORE_ID, "staff-1", {
        importId: "import-1",
        resolveDuplicates: { abc: "skip" },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(stub.product.create).not.toHaveBeenCalled();
  });

  it("400s when a new row or an intra-import duplicate is listed as overwrite", async () => {
    stub.productImport.findFirst.mockResolvedValue(
      importTicket([
        importRow({ rowNumber: 1, status: "NEW", name: "A" }),
        importRow({ rowNumber: 2, status: "DUPLICATE", existingProductId: null, name: "B" }),
      ]),
    );
    await expect(
      confirmBulkImport(STORE_ID, "staff-1", {
        importId: "import-1",
        resolveDuplicates: { "1": "overwrite" },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });

    await expect(
      confirmBulkImport(STORE_ID, "staff-1", {
        importId: "import-1",
        resolveDuplicates: { "2": "overwrite" },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(stub.product.create).not.toHaveBeenCalled();
  });

  it("409 DUPLICATE_NAME when a new row collides with a product created after the import", async () => {
    stub.productImport.findFirst.mockResolvedValue(
      importTicket([importRow({ name: "Cold Brew 500ml" })]),
    );
    stub.product.findMany.mockResolvedValue([{ name: "Cold Brew 500ml" }]);

    await expect(
      confirmBulkImport(STORE_ID, "staff-1", { importId: "import-1" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "DUPLICATE_NAME" });
    expect(stub.product.create).not.toHaveBeenCalled();
    expect(stub.productImport.update).not.toHaveBeenCalled();
  });

  it("409 PRODUCT_LIMIT_REACHED when the count plus new rows exceeds the cap", async () => {
    stub.store.findUnique.mockResolvedValue({
      id: STORE_ID,
      subscriptionId: "sub-1",
      defaultBranchId: BRANCH_ID,
    });
    stub.subscription.findUnique.mockResolvedValue(subscriptionRow({ productCap: 2 }));
    stub.product.count.mockResolvedValue(2);
    stub.productImport.findFirst.mockResolvedValue(
      importTicket([
        importRow({ rowNumber: 1, name: "A" }),
        importRow({ rowNumber: 2, name: "B" }),
      ]),
    );

    await expect(
      confirmBulkImport(STORE_ID, "staff-1", { importId: "import-1" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "PRODUCT_LIMIT_REACHED" });
    expect(stub.product.create).not.toHaveBeenCalled();
    expect(stub.productImport.update).not.toHaveBeenCalled();
  });

  it("400s when a referenced category or unit no longer belongs to the store", async () => {
    stub.productImport.findFirst.mockResolvedValue(
      importTicket([importRow({ name: "A", categoryId: "cat-1", unitId: "unit-1" })]),
    );
    stub.category.findMany.mockResolvedValue([]);

    await expect(
      confirmBulkImport(STORE_ID, "staff-1", { importId: "import-1" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(stub.product.create).not.toHaveBeenCalled();
  });

  it("marks the ticket confirmed, updates rows, and records one bulk.imported activity", async () => {
    stub.productImport.findFirst.mockResolvedValue(
      importTicket([
        importRow({ rowNumber: 1, name: "Cold Brew 500ml", initialStock: 5 }),
        importRow({
          rowNumber: 2,
          status: "DUPLICATE",
          existingProductId: "p-existing",
          name: "Old",
        }),
      ]),
    );
    stub.product.create.mockResolvedValue(productRow({ name: "Cold Brew 500ml" }));
    stub.product.updateMany.mockResolvedValue({ count: 1 });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow({ id: "p-existing" }));

    const result = await confirmBulkImport(STORE_ID, "staff-1", {
      importId: "import-1",
      resolveDuplicates: { "2": "overwrite" },
    });

    expect(stub.productImport.update).toHaveBeenCalledWith({
      where: { id: "import-1" },
      data: { status: "CONFIRMED", confirmedAt: expect.any(Date) },
    });
    expect(stub.productImportRow.update).toHaveBeenCalledWith({
      where: { importId_rowNumber: { importId: "import-1", rowNumber: 1 } },
      data: { createdProductId: "product-1" },
    });
    expect(stub.productImportRow.update).toHaveBeenCalledWith({
      where: { importId_rowNumber: { importId: "import-1", rowNumber: 2 } },
      data: { overwrite: true, existingProductId: "p-existing" },
    });
    expect(stub.storeActivityLog.create).toHaveBeenCalledTimes(1);
    expect(stub.storeActivityLog.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        staffMemberId: "staff-1",
        action: "bulk.imported",
        detail: { importId: "import-1", created: 1, overwritten: 1, skipped: 0, failed: 0 },
      },
    });
    expect(result.skipped).toEqual([]);
    expect(result.created).toHaveLength(1);
    expect(result.overwritten).toHaveLength(1);
  });
});
