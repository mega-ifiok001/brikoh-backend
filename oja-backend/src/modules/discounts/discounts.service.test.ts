import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

const activityMocks = vi.hoisted(() => ({ logStoreActivity: vi.fn() }));
vi.mock("../activity/service.js", () => ({
  logStoreActivity: activityMocks.logStoreActivity,
}));

import {
  createDiscount,
  deleteDiscount,
  getDiscount,
  listDiscounts,
  updateDiscount,
} from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  discount: {
    findMany: Mock;
    findFirst: Mock;
    create: Mock;
    updateMany: Mock;
    findUniqueOrThrow: Mock;
    deleteMany: Mock;
  };
}

const STORE_ID = "c0000000-0000-4000-8000-000000000001";
const DISCOUNT_ID = "c0000000-0000-4000-8000-000000000002";
const STAFF_ID = "c0000000-0000-4000-8000-000000000003";
const D = (v: string | number) => new Prisma.Decimal(v);

const DISCOUNT_ROW = {
  id: DISCOUNT_ID,
  name: "Grand Opening 10%",
  type: "PERCENTAGE",
  value: D("10.00"),
  code: "GRAND-OPENING",
  startsAt: null,
  endsAt: null,
  isActive: true,
  createdAt: new Date("2026-08-13T10:00:00.000Z"),
  updatedAt: new Date("2026-08-13T10:00:00.000Z"),
};

function createPrismaStub(): PrismaStub {
  return {
    discount: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createPrismaStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  activityMocks.logStoreActivity.mockReset();
  activityMocks.logStoreActivity.mockResolvedValue(undefined);
});

describe("listDiscounts (unit)", () => {
  it("pages newest-first, maps Decimal values to strings, and reports nextCursor", async () => {
    stub.discount.findMany.mockResolvedValue([{ ...DISCOUNT_ROW, id: "discount-2" }, DISCOUNT_ROW]);

    const result = await listDiscounts(STORE_ID, { limit: 2 });

    expect(result.items[0]!.id).toBe("discount-2");
    expect(result.items[1]).toEqual({
      ...DISCOUNT_ROW,
      value: "10.00",
    });
    expect(result.nextCursor).toBe(DISCOUNT_ID);
    expect(stub.discount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: STORE_ID },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 2,
      }),
    );
  });

  it("applies isActive/type filters and a cursor", async () => {
    stub.discount.findMany.mockResolvedValue([]);

    await listDiscounts(STORE_ID, {
      isActive: "false",
      type: "FIXED",
      cursor: "c0000000-0000-4000-8000-000000000099",
      limit: 10,
    });

    expect(stub.discount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: STORE_ID,
          isActive: false,
          type: "FIXED",
          id: { lt: "c0000000-0000-4000-8000-000000000099" },
        },
        take: 10,
      }),
    );
  });

  it("rejects a bad limit with 400 VALIDATION_ERROR", async () => {
    await expect(listDiscounts(STORE_ID, { limit: 0 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("createDiscount (unit)", () => {
  it("creates the discount with an uppercased code and logs discount.created", async () => {
    stub.discount.create.mockResolvedValue(DISCOUNT_ROW);

    const result = await createDiscount(STORE_ID, STAFF_ID, {
      name: "Grand Opening 10%",
      type: "PERCENTAGE",
      value: "10",
      code: "grand-opening",
    });

    expect(stub.discount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storeId: STORE_ID,
          name: "Grand Opening 10%",
          type: "PERCENTAGE",
          value: "10.00",
          code: "GRAND-OPENING",
          isActive: true,
        }),
      }),
    );
    expect(result.value).toBe("10.00");
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(stub, {
      storeId: STORE_ID,
      staffMemberId: STAFF_ID,
      action: "discount.created",
      detail: { discountId: DISCOUNT_ID, name: "Grand Opening 10%" },
    });
  });

  it("rejects a duplicate code with 409 DISCOUNT_CODE_TAKEN", async () => {
    stub.discount.create.mockRejectedValue({
      code: "P2002",
      meta: { target: ["storeId", "code"] },
    });

    await expect(
      createDiscount(STORE_ID, undefined, { name: "X", type: "FIXED", value: "5", code: "SAME" }),
    ).rejects.toMatchObject({ code: "DISCOUNT_CODE_TAKEN", statusCode: 409 });
  });

  it("rejects a PERCENTAGE over 100 and a value of zero (400 VALIDATION_ERROR)", async () => {
    await expect(
      createDiscount(STORE_ID, undefined, { name: "X", type: "PERCENTAGE", value: "150" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      createDiscount(STORE_ID, undefined, { name: "X", type: "FIXED", value: "0" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(stub.discount.create).not.toHaveBeenCalled();
  });

  it("rejects a validity window where endsAt is not after startsAt", async () => {
    await expect(
      createDiscount(STORE_ID, undefined, {
        name: "X",
        type: "FIXED",
        value: "5",
        startsAt: "2026-08-20T00:00:00.000Z",
        endsAt: "2026-08-19T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("getDiscount (unit)", () => {
  it("returns the mapped discount", async () => {
    stub.discount.findFirst.mockResolvedValue(DISCOUNT_ROW);

    const result = await getDiscount(STORE_ID, DISCOUNT_ID);

    expect(result.value).toBe("10.00");
    expect(stub.discount.findFirst).toHaveBeenCalledWith({
      where: { id: DISCOUNT_ID, storeId: STORE_ID },
    });
  });

  it("rejects an unknown or cross-tenant discount with 404 DISCOUNT_NOT_FOUND", async () => {
    stub.discount.findFirst.mockResolvedValue(null);

    await expect(getDiscount(STORE_ID, DISCOUNT_ID)).rejects.toMatchObject({
      code: "DISCOUNT_NOT_FOUND",
      statusCode: 404,
    });
  });
});

describe("updateDiscount (unit)", () => {
  it("updates provided fields and logs discount.updated", async () => {
    stub.discount.updateMany.mockResolvedValue({ count: 1 });
    stub.discount.findUniqueOrThrow.mockResolvedValue({ ...DISCOUNT_ROW, isActive: false });

    const result = await updateDiscount(STORE_ID, STAFF_ID, DISCOUNT_ID, { isActive: false });

    expect(stub.discount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: DISCOUNT_ID, storeId: STORE_ID },
        data: { isActive: false },
      }),
    );
    expect(result.isActive).toBe(false);
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({
        storeId: STORE_ID,
        staffMemberId: STAFF_ID,
        action: "discount.updated",
        detail: { discountId: DISCOUNT_ID, updatedFields: ["isActive"] },
      }),
    );
  });

  it("rejects a zero-row update as 404 DISCOUNT_NOT_FOUND", async () => {
    stub.discount.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      updateDiscount(STORE_ID, undefined, DISCOUNT_ID, { name: "X" }),
    ).rejects.toMatchObject({ code: "DISCOUNT_NOT_FOUND", statusCode: 404 });
  });

  it("rejects a code collision with 409 DISCOUNT_CODE_TAKEN", async () => {
    stub.discount.updateMany.mockRejectedValue({
      code: "P2002",
      meta: { target: ["storeId", "code"] },
    });

    await expect(
      updateDiscount(STORE_ID, undefined, DISCOUNT_ID, { code: "TAKEN" }),
    ).rejects.toMatchObject({ code: "DISCOUNT_CODE_TAKEN", statusCode: 409 });
  });

  it("rejects an empty body with 400 VALIDATION_ERROR", async () => {
    await expect(updateDiscount(STORE_ID, undefined, DISCOUNT_ID, {})).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("deleteDiscount (unit)", () => {
  it("deletes the discount and logs discount.deleted", async () => {
    stub.discount.deleteMany.mockResolvedValue({ count: 1 });

    await deleteDiscount(STORE_ID, STAFF_ID, DISCOUNT_ID);

    expect(stub.discount.deleteMany).toHaveBeenCalledWith({
      where: { id: DISCOUNT_ID, storeId: STORE_ID },
    });
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "discount.deleted", detail: { discountId: DISCOUNT_ID } }),
    );
  });

  it("rejects deleting an unknown discount with 404 DISCOUNT_NOT_FOUND", async () => {
    stub.discount.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteDiscount(STORE_ID, undefined, DISCOUNT_ID)).rejects.toMatchObject({
      code: "DISCOUNT_NOT_FOUND",
      statusCode: 404,
    });
  });
});
