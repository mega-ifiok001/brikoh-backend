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
  createCustomerGroup,
  deleteCustomerGroup,
  ensureDefaultGroup,
  getCustomerGroup,
  listCustomerGroups,
  updateCustomerGroup,
} from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  $transaction: Mock;
  customerGroup: {
    findMany: Mock;
    findFirst: Mock;
    create: Mock;
    updateMany: Mock;
    deleteMany: Mock;
    findFirstOrThrow: Mock;
    count: Mock;
  };
  discount: { findFirst: Mock };
  customer: { findMany: Mock; count: Mock };
}

const STORE_ID = "c0000000-0000-4000-8000-000000000001";
const GROUP_ID = "c0000000-0000-4000-8000-000000000002";
const DISCOUNT_ID = "c0000000-0000-4000-8000-000000000003";
const STAFF_ID = "c0000000-0000-4000-8000-000000000004";
const D = (v: string | number) => new Prisma.Decimal(v);

const GROUP_ROW = {
  id: GROUP_ID,
  name: "Wholesale",
  description: "Resellers",
  createdAt: new Date("2026-08-13T10:00:00.000Z"),
  updatedAt: new Date("2026-08-13T10:00:00.000Z"),
  discount: null,
  _count: { customers: 2 },
};

function createPrismaStub(): PrismaStub {
  return {
    $transaction: vi.fn(),
    customerGroup: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      findFirstOrThrow: vi.fn(),
      count: vi.fn(),
    },
    discount: { findFirst: vi.fn() },
    customer: { findMany: vi.fn(), count: vi.fn() },
  };
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createPrismaStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  activityMocks.logStoreActivity.mockReset();
  activityMocks.logStoreActivity.mockResolvedValue(undefined);
  stub.$transaction.mockImplementation(async (fn: (tx: PrismaStub) => Promise<unknown>) =>
    fn(stub),
  );
});

describe("listCustomerGroups (unit)", () => {
  it("maps rows to summaries with member counts and discount summaries", async () => {
    stub.customerGroup.findMany.mockResolvedValue([
      {
        ...GROUP_ROW,
        discount: {
          id: DISCOUNT_ID,
          name: "Wholesale 5%",
          type: "PERCENTAGE",
          value: D("5.00"),
        },
      },
    ]);

    const result = await listCustomerGroups(STORE_ID);

    expect(result[0]).toEqual({
      id: GROUP_ID,
      name: "Wholesale",
      description: "Resellers",
      memberCount: 2,
      discount: { id: DISCOUNT_ID, name: "Wholesale 5%", type: "PERCENTAGE", value: "5.00" },
      createdAt: GROUP_ROW.createdAt,
      updatedAt: GROUP_ROW.updatedAt,
    });
    expect(stub.customerGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: STORE_ID }, orderBy: { createdAt: "asc" } }),
    );
  });
});

describe("createCustomerGroup (unit)", () => {
  it("creates the group, logs customerGroup.created, and attaches a tenant-owned discount", async () => {
    stub.discount.findFirst.mockResolvedValue({ id: DISCOUNT_ID });
    stub.customerGroup.create.mockResolvedValue({
      ...GROUP_ROW,
      discount: { id: DISCOUNT_ID, name: "Wholesale 5%", type: "PERCENTAGE", value: D("5.00") },
    });

    const result = await createCustomerGroup(STORE_ID, STAFF_ID, {
      name: "Wholesale",
      description: "Resellers",
      discountId: DISCOUNT_ID,
    });

    expect(stub.discount.findFirst).toHaveBeenCalledWith({
      where: { id: DISCOUNT_ID, storeId: STORE_ID },
      select: { id: true },
    });
    expect(stub.customerGroup.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storeId: STORE_ID,
          name: "Wholesale",
          description: "Resellers",
          discountId: DISCOUNT_ID,
        }),
      }),
    );
    expect(result.memberCount).toBe(2);
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(stub, {
      storeId: STORE_ID,
      staffMemberId: STAFF_ID,
      action: "customerGroup.created",
      detail: { groupId: GROUP_ID, name: "Wholesale" },
    });
  });

  it("rejects an attached discount that is not in the store (404 DISCOUNT_NOT_FOUND)", async () => {
    stub.discount.findFirst.mockResolvedValue(null);

    await expect(
      createCustomerGroup(STORE_ID, STAFF_ID, { name: "Wholesale", discountId: DISCOUNT_ID }),
    ).rejects.toMatchObject({ code: "DISCOUNT_NOT_FOUND", statusCode: 404 });
    expect(stub.customerGroup.create).not.toHaveBeenCalled();
  });

  it("rejects a duplicate name with 409 GROUP_NAME_TAKEN", async () => {
    stub.customerGroup.create.mockRejectedValue({
      code: "P2002",
      meta: { target: ["storeId", "name"] },
    });

    await expect(
      createCustomerGroup(STORE_ID, undefined, { name: "Wholesale" }),
    ).rejects.toMatchObject({ code: "GROUP_NAME_TAKEN", statusCode: 409 });
  });

  it("rejects invalid input (empty name) with 400 VALIDATION_ERROR", async () => {
    await expect(createCustomerGroup(STORE_ID, undefined, { name: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(stub.customerGroup.create).not.toHaveBeenCalled();
  });
});

describe("getCustomerGroup (unit)", () => {
  it("returns the group with up to 50 recent members", async () => {
    stub.customerGroup.findFirst.mockResolvedValue(GROUP_ROW);
    stub.customer.findMany.mockResolvedValue([
      { id: "cust-1", name: "Ade", phone: null, email: null, createdAt: new Date() },
    ]);

    const result = await getCustomerGroup(STORE_ID, GROUP_ID);

    expect(result.group.memberCount).toBe(2);
    expect(result.members).toHaveLength(1);
    expect(stub.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: STORE_ID, groupId: GROUP_ID }, take: 50 }),
    );
  });

  it("rejects an unknown or cross-tenant group with 404 CUSTOMER_GROUP_NOT_FOUND", async () => {
    stub.customerGroup.findFirst.mockResolvedValue(null);

    await expect(getCustomerGroup(STORE_ID, GROUP_ID)).rejects.toMatchObject({
      code: "CUSTOMER_GROUP_NOT_FOUND",
      statusCode: 404,
    });
  });
});

describe("updateCustomerGroup (unit)", () => {
  it("updates provided fields and logs customerGroup.updated", async () => {
    stub.customerGroup.updateMany.mockResolvedValue({ count: 1 });
    stub.customerGroup.findFirstOrThrow.mockResolvedValue({
      ...GROUP_ROW,
      name: "Wholesale (New)",
    });

    const result = await updateCustomerGroup(STORE_ID, STAFF_ID, GROUP_ID, {
      name: "Wholesale (New)",
    });

    expect(stub.customerGroup.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: GROUP_ID, storeId: STORE_ID },
        data: { name: "Wholesale (New)" },
      }),
    );
    expect(result.name).toBe("Wholesale (New)");
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({
        storeId: STORE_ID,
        staffMemberId: STAFF_ID,
        action: "customerGroup.updated",
        detail: { groupId: GROUP_ID, updatedFields: ["name"] },
      }),
    );
  });

  it("rejects a zero-row update as 404 CUSTOMER_GROUP_NOT_FOUND", async () => {
    stub.customerGroup.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      updateCustomerGroup(STORE_ID, undefined, GROUP_ID, { name: "X" }),
    ).rejects.toMatchObject({ code: "CUSTOMER_GROUP_NOT_FOUND", statusCode: 404 });
  });

  it("rejects a rename collision with 409 GROUP_NAME_TAKEN", async () => {
    stub.customerGroup.updateMany.mockRejectedValue({
      code: "P2002",
      meta: { target: ["storeId", "name"] },
    });

    await expect(
      updateCustomerGroup(STORE_ID, undefined, GROUP_ID, { name: "Dupe" }),
    ).rejects.toMatchObject({ code: "GROUP_NAME_TAKEN", statusCode: 409 });
  });

  it("rejects an empty body with 400 VALIDATION_ERROR", async () => {
    await expect(updateCustomerGroup(STORE_ID, undefined, GROUP_ID, {})).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("deleteCustomerGroup (unit)", () => {
  it("refuses to delete a group with assigned customers (409 GROUP_HAS_CUSTOMERS)", async () => {
    stub.customer.count.mockResolvedValue(3);

    await expect(deleteCustomerGroup(STORE_ID, STAFF_ID, GROUP_ID)).rejects.toMatchObject({
      code: "GROUP_HAS_CUSTOMERS",
      statusCode: 409,
    });
    expect(stub.customerGroup.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes an empty group and logs customerGroup.deleted", async () => {
    stub.customer.count.mockResolvedValue(0);
    stub.customerGroup.deleteMany.mockResolvedValue({ count: 1 });

    await deleteCustomerGroup(STORE_ID, STAFF_ID, GROUP_ID);

    expect(stub.customerGroup.deleteMany).toHaveBeenCalledWith({
      where: { id: GROUP_ID, storeId: STORE_ID },
    });
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "customerGroup.deleted", detail: { groupId: GROUP_ID } }),
    );
  });

  it("rejects deleting an unknown group with 404 CUSTOMER_GROUP_NOT_FOUND", async () => {
    stub.customer.count.mockResolvedValue(0);
    stub.customerGroup.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteCustomerGroup(STORE_ID, undefined, GROUP_ID)).rejects.toMatchObject({
      code: "CUSTOMER_GROUP_NOT_FOUND",
      statusCode: 404,
    });
  });
});

describe("ensureDefaultGroup (unit)", () => {
  const client = (): PrismaClient => stub as unknown as PrismaClient;

  it("returns the existing General group when present", async () => {
    stub.customerGroup.findFirst.mockResolvedValue({ id: GROUP_ID });

    await expect(ensureDefaultGroup(client(), STORE_ID)).resolves.toBe(GROUP_ID);
    expect(stub.customerGroup.create).not.toHaveBeenCalled();
  });

  it("creates the General group lazily on first use", async () => {
    stub.customerGroup.findFirst.mockResolvedValue(null);
    stub.customerGroup.create.mockResolvedValue({ id: GROUP_ID });

    await expect(ensureDefaultGroup(client(), STORE_ID)).resolves.toBe(GROUP_ID);
    expect(stub.customerGroup.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storeId: STORE_ID, name: "General" }),
      }),
    );
  });

  it("recovers from a unique-constraint race by re-reading", async () => {
    stub.customerGroup.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: GROUP_ID });
    stub.customerGroup.create.mockRejectedValue({
      code: "P2002",
      meta: { target: ["storeId", "name"] },
    });

    await expect(ensureDefaultGroup(client(), STORE_ID)).resolves.toBe(GROUP_ID);
  });
});
