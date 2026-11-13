import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";

// Prisma is stubbed at the module boundary, matching the auth-service
// unit-test pattern: getPrismaClient() resolves to an in-memory stub.
const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

const cleanupMocks = vi.hoisted(() => ({ scheduleProductImageCleanup: vi.fn() }));
vi.mock("../../modules/uploads/cleanup.js", () => ({
  scheduleProductImageCleanup: cleanupMocks.scheduleProductImageCleanup,
}));

import {
  createProduct,
  getProduct,
  listProducts,
  publishProduct,
  softDeleteProduct,
  unpublishProduct,
  updateProduct,
} from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  $transaction: Mock;
  store: { findUnique: Mock };
  subscription: { findUnique: Mock };
  storeActivityLog: { create: Mock };
  stockLedgerEntry: { create: Mock };
  branchStock: { create: Mock };
  category: { findFirst: Mock };
  unit: { findFirst: Mock };
  productVariant: { count: Mock };
  product: {
    create: Mock;
    findMany: Mock;
    findFirst: Mock;
    findUnique: Mock;
    findUniqueOrThrow: Mock;
    updateMany: Mock;
    count: Mock;
  };
}

function createStub(): PrismaStub {
  const stub: PrismaStub = {
    // The transaction mock INVOKES the callback with the stub itself as
    // the tx client, so product.create assertions observe the same mock
    // and recordInitialStockChanges runs against it.
    $transaction: vi.fn((cb: (tx: PrismaClient) => unknown) => cb(stub as unknown as PrismaClient)),
    store: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: STORE_ID, subscriptionId: null, defaultBranchId: BRANCH_ID }),
    },
    subscription: { findUnique: vi.fn().mockResolvedValue(null) },
    storeActivityLog: { create: vi.fn() },
    stockLedgerEntry: { create: vi.fn() },
    branchStock: { create: vi.fn() },
    category: { findFirst: vi.fn() },
    unit: { findFirst: vi.fn() },
    productVariant: { count: vi.fn().mockResolvedValue(0) },
    product: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
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
    productCap: 2,
    orderCap: null,
    createdAt: new Date("2026-08-02T00:00:00Z"),
    updatedAt: new Date("2026-08-02T00:00:00Z"),
    ...overrides,
  };
}

const STORE_ID = "store-1";

const BRANCH_ID = "branch-1";

/** The include the service attaches to every product read. */
const VARIANTS_INCLUDE = {
  variants: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      optionValues: {
        select: {
          optionValue: { select: { value: true, option: { select: { name: true } } } },
        },
      },
    },
  },
  options: {
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    include: { values: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } },
  },
  category: true,
  unit: true,
};

/** List-only: the variants include plus the salesCount relation count. */
const LIST_INCLUDE = {
  ...VARIANTS_INCLUDE,
  _count: { select: { orderLineItems: true } },
};

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-1",
    storeId: STORE_ID,
    name: "Ground Coffee 500g",
    price: "12.50",
    description: "Single-origin arabica",
    images: [],
    quantity: 10,
    deletedAt: null,
    options: [],
    variants: [],
    _count: { orderLineItems: 3 },
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    ...overrides,
  };
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  cleanupMocks.scheduleProductImageCleanup.mockReset();
});

describe("createProduct (unit)", () => {
  it("creates a product for the tenant with validated input", async () => {
    stub.product.create.mockResolvedValue({ id: "product-1" });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow());

    const result = await createProduct(STORE_ID, {
      name: "  Ground Coffee 500g  ",
      price: 12.5,
      description: "Single-origin arabica",
      images: ["https://cdn.example.com/coffee.jpg"],
    });

    expect(stub.product.create).toHaveBeenCalledWith({
      data: {
        storeId: "store-1",
        name: "Ground Coffee 500g",
        price: "12.50",
        description: "Single-origin arabica",
        images: ["https://cdn.example.com/coffee.jpg"],
      },
      select: { id: true },
    });
    expect(result.price).toBe("12.50");
  });

  it("normalizes a string price with 2dp to its decimal form", async () => {
    stub.product.create.mockResolvedValue({ id: "product-1" });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow({ price: "19.99" }));
    const result = await createProduct(STORE_ID, { name: "Mug", price: "19.99" });
    expect(stub.product.create).toHaveBeenCalledWith({
      data: { storeId: "store-1", name: "Mug", price: "19.99", images: [] },
      select: { id: true },
    });
    expect(result.price).toBe("19.99");
  });

  it("passes an optional costPrice through normalized to 2dp", async () => {
    stub.product.create.mockResolvedValue({ id: "product-1" });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow({ costPrice: "5.50" }));
    const result = await createProduct(STORE_ID, { name: "Mug", price: 12, costPrice: "5.5" });
    expect(stub.product.create).toHaveBeenCalledWith({
      data: { storeId: "store-1", name: "Mug", price: "12.00", costPrice: "5.50", images: [] },
      select: { id: true },
    });
    expect(result.costPrice).toBe("5.50");
  });

  it("omits costPrice from the write when not provided", async () => {
    stub.product.create.mockResolvedValue({ id: "product-1" });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow());
    await createProduct(STORE_ID, { name: "Mug", price: 12 });
    expect(stub.product.create).toHaveBeenCalledWith({
      data: { storeId: "store-1", name: "Mug", price: "12.00", images: [] },
      select: { id: true },
    });
  });

  it.each([
    [{ name: "" }, "empty name"],
    [{ name: "x".repeat(121) }, "overlong name"],
    [{ name: "Mug", price: 0 }, "zero price"],
    [{ name: "Mug", price: -5 }, "negative price"],
    [{ name: "Mug", price: 12.345 }, "price with 3dp"],
    [{ name: "Mug", price: "12.345" }, "string price with 3dp"],
    [{ name: "Mug", price: 100_000_000 }, "price over the 10,2 cap"],
    [{ name: "Mug", price: 5, description: "x".repeat(2001) }, "overlong description"],
    [{ name: "Mug", price: 5, images: ["not-a-url"] }, "non-URL image"],
    [
      { name: "Mug", price: 5, images: new Array(11).fill("https://cdn.example.com/a.jpg") },
      "too many images",
    ],
  ])("rejects invalid input %s", async (_input, label) => {
    await expect(createProduct(STORE_ID, _input)).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
    expect(stub.product.create).not.toHaveBeenCalled();
    void label;
  });

  describe("productCap (unit)", () => {
    function attachSubscription(overrides: Record<string, unknown> = {}) {
      stub.store.findUnique.mockResolvedValue({
        id: STORE_ID,
        subscriptionId: "sub-1",
        defaultBranchId: BRANCH_ID,
      });
      stub.subscription.findUnique.mockResolvedValue(
        subscriptionRow({ productCap: 2, ...overrides }),
      );
    }

    it("allows creation under the cap (count < cap)", async () => {
      attachSubscription();
      stub.product.count.mockResolvedValue(1); // 1 product exists, cap 2
      stub.product.create.mockResolvedValue({ id: "product-1" });
      stub.product.findUniqueOrThrow.mockResolvedValue(productRow());

      const result = await createProduct(STORE_ID, { name: "Latte", price: 3.5 });

      expect(stub.product.count).toHaveBeenCalledWith({
        where: { storeId: STORE_ID, deletedAt: null },
      });
      expect(stub.product.create).toHaveBeenCalled();
      expect(result.name).toBe("Ground Coffee 500g");
    });

    it("rejects exactly at the cap (count == cap) with PRODUCT_LIMIT_REACHED", async () => {
      attachSubscription();
      stub.product.count.mockResolvedValue(2); // at cap 2

      await expect(createProduct(STORE_ID, { name: "Latte", price: 3.5 })).rejects.toMatchObject({
        statusCode: 409,
        code: "PRODUCT_LIMIT_REACHED",
      });
      expect(stub.product.create).not.toHaveBeenCalled();
    });

    it("rejects over the cap with an upgrade-promoting message", async () => {
      attachSubscription();
      stub.product.count.mockResolvedValue(3); // over cap 2 — e.g. a concurrent/legacy create

      await expect(createProduct(STORE_ID, { name: "Brew", price: 4 })).rejects.toMatchObject({
        statusCode: 409,
        code: "PRODUCT_LIMIT_REACHED",
      });
      // message must prompt an upgrade, not be a generic 500-style message
      try {
        await createProduct(STORE_ID, { name: "Brew", price: 4 });
        throw new Error("unreachable");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).message).toMatch(/upgrade/i);
        expect((err as AppError).message).not.toMatch(/internal/i);
      }
    });

    it("is unlimited when the store has no subscription", async () => {
      // stub defaults: subscriptionId null
      stub.product.count.mockResolvedValue(99999);
      stub.product.create.mockResolvedValue({ id: "product-1" });
      stub.product.findUniqueOrThrow.mockResolvedValue(productRow());

      await createProduct(STORE_ID, { name: "Latte", price: 3.5 });
      expect(stub.product.count).not.toHaveBeenCalled();
      expect(stub.product.create).toHaveBeenCalled();
    });

    it("uses the tier-default cap when the row cap is null", async () => {
      attachSubscription({ productCap: null, tier: "STARTER" }); // STARTER default productCap = 1
      stub.product.count.mockResolvedValue(0); // under the default (1)
      stub.product.create.mockResolvedValue({ id: "product-1" });
      stub.product.findUniqueOrThrow.mockResolvedValue(productRow());

      await createProduct(STORE_ID, { name: "Latte", price: 3.5 });
      expect(stub.product.create).toHaveBeenCalled();
    });
  });
});

describe("getProduct (unit)", () => {
  it("returns the product when it belongs to the tenant and is not deleted", async () => {
    stub.product.findFirst.mockResolvedValue(productRow());
    const result = await getProduct(STORE_ID, "product-1");
    expect(stub.product.findFirst).toHaveBeenCalledWith({
      where: { id: "product-1", storeId: "store-1", deletedAt: null },
      include: VARIANTS_INCLUDE,
    });
    expect(result.id).toBe("product-1");
  });

  it("throws 404 when the product is missing, cross-tenant, or soft-deleted", async () => {
    stub.product.findFirst.mockResolvedValue(null);
    await expect(getProduct(STORE_ID, "product-unknown")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });
});

describe("listProducts (unit)", () => {
  it("lists non-deleted products of the tenant ordered by createdAt DESC, id DESC", async () => {
    stub.product.findMany.mockResolvedValue([productRow({ id: "product-2" })]);
    stub.product.count.mockResolvedValue(3);

    const result = await listProducts(STORE_ID, { limit: 50 });

    expect(stub.product.findMany).toHaveBeenCalledWith({
      where: { storeId: "store-1", deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
      skip: 0,
      cursor: undefined,
      include: LIST_INCLUDE,
    });
    expect(result.total).toBe(3);
    expect(result.nextCursor).toBeNull();
    expect(result.items.map((p) => p.id)).toEqual(["product-2"]);
    expect(result.items[0]!.salesCount).toBe(3);
  });

  it("returns a nextCursor only when a page is full (more rows follow)", async () => {
    // The stub simulates the cursor skip: 51 rows AFTER the cursor row,
    // so the page is the first 50 of them and one more row follows.
    const rows = Array.from({ length: 51 }, (_, i) => productRow({ id: `product-${i + 1}` }));
    stub.product.findMany.mockResolvedValue(rows);
    stub.product.count.mockResolvedValue(120);

    const result = await listProducts(STORE_ID, { limit: 50, cursor: "product-0" });

    expect(stub.product.findMany).toHaveBeenCalledWith({
      where: { storeId: "store-1", deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
      skip: 1,
      cursor: { id: "product-0" },
      include: LIST_INCLUDE,
    });
    expect(result.items).toHaveLength(50);
    expect(result.nextCursor).toBe("product-50");
    expect(result.items[0]!.id).toBe("product-1");
    expect(result.items.some((p) => p.id === "product-0")).toBe(false);
  });

  it.each([
    [{ limit: 0 }, "limit below minimum"],
    [{ limit: 201 }, "limit above maximum"],
  ])("rejects invalid pagination %s", async (_input) => {
    await expect(listProducts(STORE_ID, _input)).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("treats a nonexistent cursor as a validation error", async () => {
    stub.product.findUnique.mockResolvedValue(null);
    await expect(
      listProducts(STORE_ID, { limit: 50, cursor: "product-ghost" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(stub.product.findMany).not.toHaveBeenCalled();
  });
});

describe("updateProduct (unit)", () => {
  it("updates only the provided fields for the tenant's non-deleted product", async () => {
    stub.product.updateMany.mockResolvedValue({ count: 1 });
    stub.product.findUniqueOrThrow.mockResolvedValue(
      productRow({ name: "Renamed Mug", price: "9.99" }),
    );

    const result = await updateProduct(STORE_ID, "product-1", { name: "Renamed Mug", price: 9.99 });

    expect(stub.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", storeId: "store-1", deletedAt: null },
      data: { name: "Renamed Mug", price: "9.99" },
    });
    expect(result.name).toBe("Renamed Mug");
  });

  it("clears the description when explicitly set to null", async () => {
    stub.product.updateMany.mockResolvedValue({ count: 1 });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow({ description: null }));

    await updateProduct(STORE_ID, "product-1", { description: null });

    expect(stub.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", storeId: "store-1", deletedAt: null },
      data: { description: null },
    });
  });

  it("updates costPrice normalized and clears it with null", async () => {
    stub.product.updateMany.mockResolvedValue({ count: 1 });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow({ costPrice: "4.75" }));

    await updateProduct(STORE_ID, "product-1", { costPrice: 4.75 });
    expect(stub.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", storeId: "store-1", deletedAt: null },
      data: { costPrice: "4.75" },
    });

    await updateProduct(STORE_ID, "product-1", { costPrice: null });
    expect(stub.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", storeId: "store-1", deletedAt: null },
      data: { costPrice: null },
    });
  });

  it("rejects an attempt to change quantity through the product endpoint", async () => {
    await expect(
      updateProduct(STORE_ID, "product-1", { quantity: 99 } as never),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(stub.product.updateMany).not.toHaveBeenCalled();
  });

  it("throws 404 when the update matches no tenant row", async () => {
    stub.product.updateMany.mockResolvedValue({ count: 0 });
    await expect(updateProduct(STORE_ID, "product-missing", { name: "X" })).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });

  it("schedules cleanup of Cloudinary images removed by the update", async () => {
    const currentUrl = "https://res.cloudinary.com/test-cloud/image/upload/stores/store-1/uuid-old.png";
    const newUrl = "https://res.cloudinary.com/test-cloud/image/upload/stores/store-1/uuid-new.png";
    stub.product.findFirst.mockResolvedValue({
      images: [currentUrl, newUrl],
      coverImageUrl: currentUrl,
    });
    stub.product.updateMany.mockResolvedValue({ count: 1 });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow({ images: [newUrl], coverImageUrl: newUrl }));

    await updateProduct(STORE_ID, "product-1", {
      images: [newUrl],
      coverImageUrl: newUrl,
    });

    expect(cleanupMocks.scheduleProductImageCleanup).toHaveBeenCalledWith("store-1", [currentUrl]);
  });

  it("does not schedule cleanup when the update leaves images unchanged", async () => {
    const url = "https://res.cloudinary.com/test-cloud/image/upload/stores/store-1/uuid-keep.png";
    stub.product.findFirst.mockResolvedValue({ images: [url], coverImageUrl: url });
    stub.product.updateMany.mockResolvedValue({ count: 1 });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow({ images: [url], coverImageUrl: url }));

    await updateProduct(STORE_ID, "product-1", { name: "Renamed" });

    expect(cleanupMocks.scheduleProductImageCleanup).not.toHaveBeenCalled();
  });

  it("does not schedule cleanup when only non-image fields change", async () => {
    stub.product.findFirst.mockResolvedValue({ images: [], coverImageUrl: null });
    stub.product.updateMany.mockResolvedValue({ count: 1 });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow());

    await updateProduct(STORE_ID, "product-1", { price: 9.99 });

    expect(cleanupMocks.scheduleProductImageCleanup).not.toHaveBeenCalled();
  });
});

describe("softDeleteProduct (unit)", () => {
  it("soft-deletes the tenant's non-deleted product", async () => {
    stub.product.findFirst.mockResolvedValue({ images: [], coverImageUrl: null });
    stub.product.updateMany.mockResolvedValue({ count: 1 });

    await softDeleteProduct(STORE_ID, "product-1");

    expect(stub.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", storeId: "store-1", deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("schedules cleanup of all Cloudinary images on soft delete", async () => {
    const url1 = "https://res.cloudinary.com/test-cloud/image/upload/stores/store-1/uuid-1.png";
    const url2 = "https://res.cloudinary.com/test-cloud/image/upload/stores/store-1/uuid-2.png";
    stub.product.findFirst.mockResolvedValue({
      images: [url1, url2],
      coverImageUrl: url2,
    });
    stub.product.updateMany.mockResolvedValue({ count: 1 });

    await softDeleteProduct(STORE_ID, "product-1");

    expect(cleanupMocks.scheduleProductImageCleanup).toHaveBeenCalledWith("store-1", [url1, url2]);
  });

  it("does not schedule cleanup when the product has no Cloudinary images", async () => {
    stub.product.findFirst.mockResolvedValue({ images: [], coverImageUrl: null });
    stub.product.updateMany.mockResolvedValue({ count: 1 });

    await softDeleteProduct(STORE_ID, "product-1");

    expect(cleanupMocks.scheduleProductImageCleanup).not.toHaveBeenCalled();
  });

  it("is idempotent for an already-deleted product (no-op success)", async () => {
    stub.product.updateMany.mockResolvedValue({ count: 0 });
    stub.product.findFirst.mockResolvedValue(productRow({ deletedAt: new Date() }));

    await expect(softDeleteProduct(STORE_ID, "product-1")).resolves.toBeUndefined();
    expect(cleanupMocks.scheduleProductImageCleanup).not.toHaveBeenCalled();
  });

  it("throws 404 for ids that never existed in the tenant", async () => {
    stub.product.updateMany.mockResolvedValue({ count: 0 });
    stub.product.findFirst.mockResolvedValue(null);

    await expect(softDeleteProduct(STORE_ID, "product-ghost")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });
});

describe("publish/unpublish (unit)", () => {
  const publishableRow = {
    id: "product-1",
    status: "DRAFT",
    categoryId: "category-1",
    unitId: "unit-1",
    coverImageUrl: "https://cdn.example.com/cover.jpg",
    images: [],
  };

  it("publishes a product via the conditional update and logs activity", async () => {
    stub.product.findFirst.mockResolvedValue(publishableRow);
    stub.product.updateMany.mockResolvedValue({ count: 1 });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow({ status: "PUBLISHED" }));

    const result = await publishProduct(STORE_ID, "product-1");

    expect(stub.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "product-1", storeId: STORE_ID, deletedAt: null },
      }),
    );
    expect(stub.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", storeId: "store-1", deletedAt: null },
      data: { status: "PUBLISHED" },
    });
    expect(result.status).toBe("PUBLISHED");
    expect(stub.storeActivityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "product.published" }) }),
    );
  });

  it("rejects publishing when category, unit, and photo are all missing", async () => {
    stub.product.findFirst.mockResolvedValue({
      id: "product-1",
      status: "DRAFT",
      categoryId: null,
      unitId: null,
      coverImageUrl: null,
      images: [],
    });

    await expect(publishProduct(STORE_ID, "product-1")).rejects.toMatchObject({
      statusCode: 409,
      code: "PRODUCT_NOT_READY_TO_PUBLISH",
      message: expect.stringMatching(/category/),
    });
    expect(stub.product.updateMany).not.toHaveBeenCalled();
    expect(stub.storeActivityLog.create).not.toHaveBeenCalled();
  });

  it("rejects publishing when only a product photo is missing", async () => {
    stub.product.findFirst.mockResolvedValue({
      id: "product-1",
      status: "DRAFT",
      categoryId: "category-1",
      unitId: "unit-1",
      coverImageUrl: null,
      images: [],
    });

    await expect(publishProduct(STORE_ID, "product-1")).rejects.toMatchObject({
      statusCode: 409,
      code: "PRODUCT_NOT_READY_TO_PUBLISH",
      message: expect.stringMatching(/photo/i),
    });
  });

  it("accepts a gallery photo when no cover is set", async () => {
    stub.product.findFirst.mockResolvedValue({
      id: "product-1",
      status: "DRAFT",
      categoryId: "category-1",
      unitId: "unit-1",
      coverImageUrl: null,
      images: ["https://cdn.example.com/gallery.jpg"],
    });
    stub.product.updateMany.mockResolvedValue({ count: 1 });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow({ status: "PUBLISHED" }));

    await expect(publishProduct(STORE_ID, "product-1")).resolves.toMatchObject({
      status: "PUBLISHED",
    });
  });

  it("skips the prerequisite gate when republishing an already-published product", async () => {
    stub.product.findFirst.mockResolvedValue({
      id: "product-1",
      status: "PUBLISHED",
      categoryId: null,
      unitId: null,
      coverImageUrl: null,
      images: [],
    });
    stub.product.updateMany.mockResolvedValue({ count: 1 });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow({ status: "PUBLISHED" }));

    await expect(publishProduct(STORE_ID, "product-1")).resolves.toMatchObject({
      status: "PUBLISHED",
    });
    expect(stub.storeActivityLog.create).toHaveBeenCalled();
  });

  it("unpublishes back to DRAFT", async () => {
    stub.product.updateMany.mockResolvedValue({ count: 1 });
    stub.product.findUniqueOrThrow.mockResolvedValue(productRow({ status: "DRAFT" }));

    await unpublishProduct(STORE_ID, "product-1");

    expect(stub.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", storeId: "store-1", deletedAt: null },
      data: { status: "DRAFT" },
    });
    expect(stub.storeActivityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "product.unpublished" }) }),
    );
  });

  it("classifies unknown or cross-tenant products as 404", async () => {
    stub.product.findFirst.mockResolvedValue(null);
    stub.product.updateMany.mockResolvedValue({ count: 0 });
    await expect(publishProduct(STORE_ID, "nope")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
    expect(stub.storeActivityLog.create).not.toHaveBeenCalled();
  });
});
