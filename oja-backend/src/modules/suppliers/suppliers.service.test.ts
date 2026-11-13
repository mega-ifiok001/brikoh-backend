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

import { AppError } from "../../lib/AppError.js";
import {
  createSupplier,
  deleteSupplier,
  getSupplier,
  listSuppliers,
  updateSupplier,
} from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  supplier: {
    findMany: Mock;
    findFirst: Mock;
    create: Mock;
    updateMany: Mock;
    deleteMany: Mock;
    findUniqueOrThrow: Mock;
  };
  purchaseOrder: { findMany: Mock; groupBy: Mock; count: Mock };
}

const STORE_ID = "c0000000-0000-4000-8000-000000000001";
const SUPPLIER_ID = "c0000000-0000-4000-8000-000000000002";
const D = (v: string | number) => new Prisma.Decimal(v);

const SUPPLIER_ROW = {
  id: SUPPLIER_ID,
  name: "Prime Distributors",
  contactName: "Bola Adeyemi",
  phone: "+234 801 222 3333",
  email: "sales@primedistributors.example",
  address: "Lagos Island, Lagos",
  isActive: true,
  notes: null,
  createdAt: new Date("2026-08-13T10:00:00.000Z"),
  updatedAt: new Date("2026-08-13T10:00:00.000Z"),
  _count: { purchaseOrders: 2 },
};

function createPrismaStub(): PrismaStub {
  return {
    supplier: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    purchaseOrder: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
  };
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createPrismaStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  activityMocks.logStoreActivity.mockReset();
  activityMocks.logStoreActivity.mockResolvedValue(undefined);
});

describe("createSupplier (unit)", () => {
  it("creates with defaults and logs supplier.created", async () => {
    stub.supplier.create.mockResolvedValue(SUPPLIER_ROW);

    const result = await createSupplier(STORE_ID, "staff-1", { name: "Prime Distributors" });

    expect(stub.supplier.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: STORE_ID,
        name: "Prime Distributors",
        isActive: true,
        contactName: null,
      }),
      include: { _count: { select: { purchaseOrders: true } } },
    });
    expect(result.balanceDue).toBe("0.00");
    expect(result.purchaseOrderCount).toBe(2);
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "supplier.created", staffMemberId: "staff-1" }),
    );
  });

  it("maps a name collision to 409 SUPPLIER_NAME_TAKEN", async () => {
    stub.supplier.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "7",
        meta: { target: ["storeId", "name"] },
      }),
    );

    await expect(
      createSupplier(STORE_ID, undefined, { name: "Prime Distributors" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SUPPLIER_NAME_TAKEN" });
  });

  it("rejects invalid input", async () => {
    await expect(createSupplier(STORE_ID, undefined, {})).rejects.toBeInstanceOf(AppError);
    await expect(
      createSupplier(STORE_ID, undefined, { name: "x", phone: "not-a-phone" }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      createSupplier(STORE_ID, undefined, { name: "x", unknownField: 1 }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe("listSuppliers (unit)", () => {
  it("computes balanceDue from the live orders and lists by name", async () => {
    stub.supplier.findMany.mockResolvedValue([SUPPLIER_ROW]);
    stub.purchaseOrder.groupBy.mockResolvedValue([
      { supplierId: SUPPLIER_ID, _sum: { total: D("7500.00"), amountPaid: D("3000.00") } },
    ]);

    const items = await listSuppliers(STORE_ID);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: SUPPLIER_ID,
      name: "Prime Distributors",
      purchaseOrderCount: 2,
      balanceDue: "4500.00",
    });
  });

  it("drops draft/cancelled orders from the debt calculation", async () => {
    stub.supplier.findMany.mockResolvedValue([SUPPLIER_ROW]);
    stub.purchaseOrder.groupBy.mockResolvedValue([]);

    const items = await listSuppliers(STORE_ID);

    expect(stub.purchaseOrder.groupBy).toHaveBeenCalledWith({
      by: ["supplierId"],
      where: expect.objectContaining({
        status: { in: ["ORDERED", "PARTIALLY_RECEIVED", "RECEIVED"] },
      }),
      _sum: { total: true, amountPaid: true },
    });
    expect(items[0]!.balanceDue).toBe("0.00");
  });
});

describe("getSupplier (unit)", () => {
  it("returns the supplier with order history", async () => {
    stub.supplier.findFirst.mockResolvedValue(SUPPLIER_ROW);
    stub.purchaseOrder.findMany.mockResolvedValue([
      {
        id: "po-1",
        number: "PO-0001",
        status: "PARTIALLY_RECEIVED",
        total: D("7500.00"),
        amountPaid: D("3000.00"),
        createdAt: new Date("2026-08-14T09:00:00.000Z"),
        orderedAt: new Date("2026-08-14T09:05:00.000Z"),
        _count: { lineItems: 2 },
      },
    ]);
    stub.purchaseOrder.groupBy.mockResolvedValue([]);

    const result = await getSupplier(STORE_ID, SUPPLIER_ID);

    expect(result.purchaseOrders[0]).toMatchObject({
      number: "PO-0001",
      status: "PARTIALLY_RECEIVED",
      total: "7500.00",
      balanceDue: "4500.00",
      itemCount: 2,
    });
  });

  it("404s for an unknown supplier", async () => {
    stub.supplier.findFirst.mockResolvedValue(null);

    await expect(getSupplier(STORE_ID, SUPPLIER_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "SUPPLIER_NOT_FOUND",
    });
  });
});

describe("updateSupplier (unit)", () => {
  it("full-replaces fields and logs the change", async () => {
    stub.supplier.updateMany.mockResolvedValue({ count: 1 });
    stub.supplier.findUniqueOrThrow.mockResolvedValue({ ...SUPPLIER_ROW, isActive: false });
    stub.purchaseOrder.groupBy.mockResolvedValue([]);
    stub.purchaseOrder.findMany.mockResolvedValue([]);

    const result = await updateSupplier(STORE_ID, SUPPLIER_ID, undefined, {
      name: "Prime Distributors Ltd",
      isActive: false,
    });

    expect(stub.supplier.updateMany).toHaveBeenCalledWith({
      where: { id: SUPPLIER_ID, storeId: STORE_ID },
      data: expect.objectContaining({ name: "Prime Distributors Ltd", isActive: false }),
    });
    expect(result.isActive).toBe(false);
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({
        action: "supplier.updated",
        detail: expect.objectContaining({ updatedFields: ["name", "isActive"] }),
      }),
    );
  });

  it("404s when the conditional update matches nothing", async () => {
    stub.supplier.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      updateSupplier(STORE_ID, SUPPLIER_ID, undefined, { name: "X" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "SUPPLIER_NOT_FOUND" });
  });
});

describe("deleteSupplier (unit)", () => {
  it("refuses when purchase-order history exists", async () => {
    stub.purchaseOrder.count.mockResolvedValue(2);

    await expect(deleteSupplier(STORE_ID, SUPPLIER_ID, undefined)).rejects.toMatchObject({
      statusCode: 409,
      code: "SUPPLIER_HAS_ORDERS",
    });
    expect(stub.supplier.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes a supplier with no orders", async () => {
    stub.purchaseOrder.count.mockResolvedValue(0);
    stub.supplier.deleteMany.mockResolvedValue({ count: 1 });

    await deleteSupplier(STORE_ID, SUPPLIER_ID, undefined);

    expect(stub.supplier.deleteMany).toHaveBeenCalledWith({
      where: { id: SUPPLIER_ID, storeId: STORE_ID },
    });
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "supplier.deleted" }),
    );
  });

  it("404s when the delete matches nothing", async () => {
    stub.purchaseOrder.count.mockResolvedValue(0);
    stub.supplier.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteSupplier(STORE_ID, SUPPLIER_ID, undefined)).rejects.toMatchObject({
      statusCode: 404,
      code: "SUPPLIER_NOT_FOUND",
    });
  });
});
