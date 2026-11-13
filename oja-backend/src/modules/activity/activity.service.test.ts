import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

import type { PrismaClient } from "../../../generated/prisma/client.js";
import { listStoreActivity, logStoreActivity } from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  storeActivityLog: {
    create: Mock;
    findUnique: Mock;
    findMany: Mock;
    count: Mock;
  };
}

const STORE_ID = "store-1";

function createStub(): PrismaStub {
  return {
    storeActivityLog: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };
}

function entryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    storeId: STORE_ID,
    staffMemberId: null,
    action: "product.created",
    detail: { productId: "product-1" },
    createdAt: new Date("2026-08-02T10:00:00.000Z"),
    ...overrides,
  };
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
});

describe("logStoreActivity (unit)", () => {
  it("writes the entry with null staffMemberId and an empty detail default", async () => {
    await logStoreActivity(stub as unknown as Parameters<typeof logStoreActivity>[0], {
      storeId: STORE_ID,
      action: "product.created",
    });

    expect(stub.storeActivityLog.create).toHaveBeenCalledWith({
      data: { storeId: STORE_ID, staffMemberId: null, action: "product.created", detail: {} },
    });
  });

  it("passes staffMemberId and detail through", async () => {
    await logStoreActivity(stub as unknown as Parameters<typeof logStoreActivity>[0], {
      storeId: STORE_ID,
      staffMemberId: "staff-9",
      action: "stock.adjusted",
      detail: { productId: "product-1", quantityChange: 5 },
    });

    expect(stub.storeActivityLog.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        staffMemberId: "staff-9",
        action: "stock.adjusted",
        detail: { productId: "product-1", quantityChange: 5 },
      },
    });
  });
});

describe("listStoreActivity (unit)", () => {
  it("lists the tenant's entries newest first with pagination metadata", async () => {
    stub.storeActivityLog.findMany.mockResolvedValue([entryRow()]);
    stub.storeActivityLog.count.mockResolvedValue(1);

    const result = await listStoreActivity(STORE_ID, { limit: 50 });

    expect(stub.storeActivityLog.findMany).toHaveBeenCalledWith({
      where: { storeId: STORE_ID },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
      skip: 0,
      cursor: undefined,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ action: "product.created" });
    expect(result.nextCursor).toBeNull();
    expect(result.total).toBe(1);
  });

  it("returns a nextCursor only when a page is full", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => entryRow({ id: `entry-${i + 1}` }));
    stub.storeActivityLog.findMany.mockResolvedValue(rows);
    stub.storeActivityLog.count.mockResolvedValue(120);

    const result = await listStoreActivity(STORE_ID, { limit: 50 });

    expect(result.items).toHaveLength(50);
    expect(result.nextCursor).toBe("entry-50");
  });

  it("filters by staffMemberId and the inclusive/exclusive UTC window", async () => {
    stub.storeActivityLog.findMany.mockResolvedValue([]);
    stub.storeActivityLog.count.mockResolvedValue(0);

    await listStoreActivity(STORE_ID, {
      staffMemberId: "staff-1",
      start: "2026-08-01T00:00:00Z",
      end: "2026-09-01T00:00:00Z",
    });

    expect(stub.storeActivityLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: STORE_ID,
          staffMemberId: "staff-1",
          createdAt: {
            gte: new Date("2026-08-01T00:00:00Z"),
            lt: new Date("2026-09-01T00:00:00Z"),
          },
        },
      }),
    );
  });

  it("treats a nonexistent cursor as a validation error", async () => {
    stub.storeActivityLog.findUnique.mockResolvedValue(null);

    await expect(
      listStoreActivity(STORE_ID, { limit: 50, cursor: "entry-ghost" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
    expect(stub.storeActivityLog.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { params: { limit: 0 }, label: "limit below minimum" },
    { params: { limit: 201 }, label: "limit above maximum" },
    { params: { start: "not-a-date" }, label: "non-ISO start" },
    { params: { end: "2026-01-01" }, label: "date without time" },
  ])("rejects invalid query params ($label)", async ({ params }) => {
    await expect(listStoreActivity(STORE_ID, params)).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });
});
