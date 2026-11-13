import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";

// Prisma is stubbed at the module boundary, matching the auth-service
// unit-test pattern: getPrismaClient() resolves to an in-memory stub.
const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from "./categories.service.js";
import { createUnit, deleteUnit, getUnit, listUnits, updateUnit } from "./units.service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  storeActivityLog: { create: Mock };
  category: {
    create: Mock;
    findMany: Mock;
    findFirst: Mock;
    findUniqueOrThrow: Mock;
    updateMany: Mock;
    deleteMany: Mock;
  };
  unit: {
    create: Mock;
    findMany: Mock;
    findFirst: Mock;
    findUniqueOrThrow: Mock;
    updateMany: Mock;
    deleteMany: Mock;
  };
}

function createStub(): PrismaStub {
  return {
    storeActivityLog: { create: vi.fn() },
    category: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    unit: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

const STORE_ID = "store-1";

function categoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cat-1",
    storeId: STORE_ID,
    name: "Beverages",
    description: null,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    ...overrides,
  };
}

function unitRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "unit-1",
    storeId: STORE_ID,
    name: "Kilogram",
    symbol: "kg",
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    ...overrides,
  };
}

const p2002 = (target: string | string[]) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });

const p2002Adapter = (fields: string[]) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: "23505",
          kind: "UniqueConstraintViolation",
          constraint: { fields },
        },
      },
    },
  });

let stub: PrismaStub;

beforeEach(() => {
  stub = createStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
});

describe("createCategory (unit)", () => {
  it("creates a category for the tenant with validated input", async () => {
    stub.category.create.mockResolvedValue(categoryRow({ description: "Hot drinks" }));

    const result = await createCategory(STORE_ID, {
      name: "  Beverages  ",
      description: "Hot drinks",
    });

    expect(stub.category.create).toHaveBeenCalledWith({
      data: { storeId: STORE_ID, name: "Beverages", description: "Hot drinks" },
    });
    expect(result.name).toBe("Beverages");
    expect(stub.storeActivityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "catalog.category.created" }),
      }),
    );
  });

  it("stores null description when omitted", async () => {
    stub.category.create.mockResolvedValue(categoryRow());
    await createCategory(STORE_ID, { name: "Beverages" });
    expect(stub.category.create).toHaveBeenCalledWith({
      data: { storeId: STORE_ID, name: "Beverages", description: null },
    });
  });

  it.each<[{ name: string; description?: string; extra?: string }, string]>([
    [{ name: "" }, "empty name"],
    [{ name: "x".repeat(121) }, "overlong name"],
    [{ name: "B", description: "x".repeat(1001) }, "overlong description"],
    [{ name: "B", extra: "sneaky" }, "strict rejects unknown keys"],
  ])("rejects invalid input %s", async (input) => {
    await expect(createCategory(STORE_ID, input)).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
    expect(stub.category.create).not.toHaveBeenCalled();
  });

  it("maps a duplicate (storeId, name) to 409 CATEGORY_EXISTS", async () => {
    stub.category.create.mockRejectedValue(p2002(["storeId", "name"]));
    await expect(createCategory(STORE_ID, { name: "Beverages" })).rejects.toMatchObject({
      statusCode: 409,
      code: "CATEGORY_EXISTS",
    });
  });

  it("maps the driver-adapter P2002 shape to 409 CATEGORY_EXISTS", async () => {
    stub.category.create.mockRejectedValue(p2002Adapter(["storeId", "name"]));
    await expect(createCategory(STORE_ID, { name: "Beverages" })).rejects.toMatchObject({
      statusCode: 409,
      code: "CATEGORY_EXISTS",
    });
  });

  it("rethrows unrelated Prisma errors untouched", async () => {
    stub.category.create.mockRejectedValue(new Error("connection lost"));
    await expect(createCategory(STORE_ID, { name: "Beverages" })).rejects.toThrow(
      "connection lost",
    );
  });
});

describe("listCategories / getCategory (unit)", () => {
  it("lists the tenant's categories, oldest first", async () => {
    stub.category.findMany.mockResolvedValue([categoryRow()]);
    const result = await listCategories(STORE_ID);
    expect(stub.category.findMany).toHaveBeenCalledWith({
      where: { storeId: STORE_ID },
      orderBy: { createdAt: "asc" },
    });
    expect(result).toHaveLength(1);
  });

  it("returns an empty list when the tenant has none", async () => {
    stub.category.findMany.mockResolvedValue([]);
    await expect(listCategories(STORE_ID)).resolves.toEqual([]);
  });

  it("returns one category when found", async () => {
    stub.category.findFirst.mockResolvedValue(categoryRow());
    await expect(getCategory(STORE_ID, "cat-1")).resolves.toMatchObject({ id: "cat-1" });
  });

  it("classifies unknown or cross-tenant ids as 404", async () => {
    stub.category.findFirst.mockResolvedValue(null);
    await expect(getCategory(STORE_ID, "other-tenant-cat")).rejects.toBeInstanceOf(AppError);
    await expect(getCategory(STORE_ID, "other-tenant-cat")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
    expect(stub.category.findFirst).toHaveBeenCalledWith({
      where: { id: "other-tenant-cat", storeId: STORE_ID },
    });
  });
});

describe("updateCategory (unit)", () => {
  it("updates the provided fields only", async () => {
    stub.category.updateMany.mockResolvedValue({ count: 1 });
    stub.category.findUniqueOrThrow.mockResolvedValue(categoryRow({ name: "Hot Drinks" }));

    const result = await updateCategory(STORE_ID, "cat-1", { name: "Hot Drinks" });

    expect(stub.category.updateMany).toHaveBeenCalledWith({
      where: { id: "cat-1", storeId: STORE_ID },
      data: { name: "Hot Drinks" },
    });
    expect(result.name).toBe("Hot Drinks");
  });

  it("clears a description when sent explicitly null", async () => {
    stub.category.updateMany.mockResolvedValue({ count: 1 });
    stub.category.findUniqueOrThrow.mockResolvedValue(categoryRow());
    await updateCategory(STORE_ID, "cat-1", { description: null });
    expect(stub.category.updateMany).toHaveBeenCalledWith({
      where: { id: "cat-1", storeId: STORE_ID },
      data: { description: null },
    });
  });

  it("surfaces unknown or cross-tenant updates as 404", async () => {
    stub.category.updateMany.mockResolvedValue({ count: 0 });
    await expect(updateCategory(STORE_ID, "nope", { name: "X" })).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });

  it("maps a duplicate rename to 409 CATEGORY_EXISTS", async () => {
    stub.category.updateMany.mockRejectedValue(p2002Adapter(["storeId", "name"]));
    await expect(updateCategory(STORE_ID, "cat-1", { name: "Taken" })).rejects.toMatchObject({
      statusCode: 409,
      code: "CATEGORY_EXISTS",
    });
  });
});

describe("deleteCategory (unit)", () => {
  it("deletes the category when it exists in the tenant", async () => {
    stub.category.deleteMany.mockResolvedValue({ count: 1 });
    await expect(deleteCategory(STORE_ID, "cat-1")).resolves.toBeUndefined();
    expect(stub.category.deleteMany).toHaveBeenCalledWith({
      where: { id: "cat-1", storeId: STORE_ID },
    });
    expect(stub.storeActivityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "catalog.category.deleted" }),
      }),
    );
  });

  it("surfaces unknown or cross-tenant deletes as 404", async () => {
    stub.category.deleteMany.mockResolvedValue({ count: 0 });
    await expect(deleteCategory(STORE_ID, "nope")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
    expect(stub.storeActivityLog.create).not.toHaveBeenCalled();
  });
});

describe("units (unit)", () => {
  it("creates a unit with an optional symbol", async () => {
    stub.unit.create.mockResolvedValue(unitRow());
    const result = await createUnit(STORE_ID, { name: "Kilogram", symbol: "kg" });
    expect(stub.unit.create).toHaveBeenCalledWith({
      data: { storeId: STORE_ID, name: "Kilogram", symbol: "kg" },
    });
    expect(result.symbol).toBe("kg");
  });

  it("stores null symbol when omitted", async () => {
    stub.unit.create.mockResolvedValue(unitRow({ symbol: null }));
    await createUnit(STORE_ID, { name: "Dozen" });
    expect(stub.unit.create).toHaveBeenCalledWith({
      data: { storeId: STORE_ID, name: "Dozen", symbol: null },
    });
  });

  it("maps a duplicate name to 409 UNIT_EXISTS", async () => {
    stub.unit.create.mockRejectedValue(p2002(["storeId", "name"]));
    await expect(createUnit(STORE_ID, { name: "Kilogram" })).rejects.toMatchObject({
      statusCode: 409,
      code: "UNIT_EXISTS",
    });
  });

  it("lists, gets, updates, and deletes with tenant scoping", async () => {
    stub.unit.findMany.mockResolvedValue([unitRow()]);
    await expect(listUnits(STORE_ID)).resolves.toHaveLength(1);
    expect(stub.unit.findMany).toHaveBeenCalledWith({
      where: { storeId: STORE_ID },
      orderBy: { createdAt: "asc" },
    });

    stub.unit.findFirst.mockResolvedValue(null);
    await expect(getUnit(STORE_ID, "nope")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });

    stub.unit.updateMany.mockResolvedValue({ count: 0 });
    await expect(updateUnit(STORE_ID, "nope", { symbol: "k" })).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });

    stub.unit.updateMany.mockRejectedValue(p2002Adapter(["storeId", "name"]));
    await expect(updateUnit(STORE_ID, "unit-1", { name: "Taken" })).rejects.toMatchObject({
      statusCode: 409,
      code: "UNIT_EXISTS",
    });

    stub.unit.deleteMany.mockResolvedValue({ count: 0 });
    await expect(deleteUnit(STORE_ID, "nope")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });

    stub.unit.deleteMany.mockResolvedValue({ count: 1 });
    await expect(deleteUnit(STORE_ID, "unit-1")).resolves.toBeUndefined();
  });
});
