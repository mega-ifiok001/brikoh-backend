import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({ getPrismaClient: prismaMocks.getPrismaClient }));

const activityMocks = vi.hoisted(() => ({ logStoreActivity: vi.fn() }));
vi.mock("../activity/service.js", () => ({ logStoreActivity: activityMocks.logStoreActivity }));

import {
  createDeliveryOption,
  deleteDeliveryOption,
  listDeliveryOptions,
  updateDeliveryOption,
} from "./delivery-options.service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  $transaction: Mock;
  storeActivityLog: { create: Mock };
  deliveryOption: {
    findMany: Mock;
    findFirst: Mock;
    create: Mock;
    update: Mock;
    delete: Mock;
  };
  location: { findFirst: Mock };
}

const STORE_ID = "store-1";
const OPTION_ID = "opt-1";

function optionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OPTION_ID,
    storeId: STORE_ID,
    name: "Delivery Rider",
    kind: "DELIVERY",
    description: "Same-day rider",
    baseFee: { toFixed: () => "2000.00" },
    isActive: true,
    sortOrder: 0,
    pickupLocationId: null,
    pickupLocation: null,
    pickupAddressText: null,
    createdAt: new Date("2026-09-16T10:00:00.000Z"),
    updatedAt: new Date("2026-09-16T10:00:00.000Z"),
    ...overrides,
  };
}

function createStub(): PrismaStub {
  return {
    $transaction: vi.fn((cb: (tx: PrismaClient) => unknown) => cb(stub as unknown as PrismaClient)),
    storeActivityLog: { create: vi.fn() },
    deliveryOption: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    location: { findFirst: vi.fn() },
  };
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  activityMocks.logStoreActivity.mockReset();
  activityMocks.logStoreActivity.mockResolvedValue(undefined);
});

describe("listDeliveryOptions (unit)", () => {
  it("returns the store's options ordered", async () => {
    stub.deliveryOption.findMany.mockResolvedValue([optionRow()]);

    const result = await listDeliveryOptions(STORE_ID);

    expect(stub.deliveryOption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: STORE_ID } }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "Delivery Rider", baseFee: "2000.00" });
    expect(result[0]).not.toHaveProperty("zones");
  });
});

describe("createDeliveryOption (unit)", () => {
  it("creates an option with a fixed base fee", async () => {
    stub.deliveryOption.findFirst.mockResolvedValue(null); // no name clash
    stub.deliveryOption.create.mockResolvedValue(optionRow());

    const result = await createDeliveryOption(
      STORE_ID,
      { name: "Delivery Rider", kind: "DELIVERY", baseFee: "2000", description: "Same-day rider" },
      undefined,
    );

    expect(stub.deliveryOption.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storeId: STORE_ID,
          name: "Delivery Rider",
          kind: "DELIVERY",
          baseFee: "2000.00",
        }),
      }),
    );
    expect(result.name).toBe("Delivery Rider");
  });

  it("defaults baseFee to 0 when omitted (e.g. pickup)", async () => {
    stub.deliveryOption.findFirst.mockResolvedValue(null);
    stub.deliveryOption.create.mockResolvedValue(
      optionRow({ kind: "PICKUP", baseFee: { toFixed: () => "0.00" } }),
    );

    await createDeliveryOption(STORE_ID, { name: "Pick up at store", kind: "PICKUP" }, undefined);

    const data = stub.deliveryOption.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.baseFee).toBe("0.00");
  });

  it("rejects a duplicate name (409 DELIVERY_OPTION_EXISTS)", async () => {
    stub.deliveryOption.findFirst.mockResolvedValue({ id: "other" });

    await expect(
      createDeliveryOption(STORE_ID, { name: "Delivery Rider", kind: "DELIVERY" }, undefined),
    ).rejects.toMatchObject({ statusCode: 409, code: "DELIVERY_OPTION_EXISTS" });
    expect(stub.deliveryOption.create).not.toHaveBeenCalled();
  });

  it("404s a pickupLocationId that is not a store location", async () => {
    stub.deliveryOption.findFirst.mockResolvedValue(null);
    stub.location.findFirst.mockResolvedValue(null);

    await expect(
      createDeliveryOption(
        STORE_ID,
        {
          name: "Pickup",
          kind: "PICKUP",
          pickupLocationId: "11111111-1111-4111-8111-111111111111",
        },
        undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(stub.deliveryOption.create).not.toHaveBeenCalled();
  });
});

describe("updateDeliveryOption (unit)", () => {
  it("404s an unknown / cross-tenant option", async () => {
    stub.deliveryOption.findFirst.mockResolvedValue(null);

    await expect(
      updateDeliveryOption(STORE_ID, OPTION_ID, { name: "X" }, undefined),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("updates the base fee / active flag", async () => {
    stub.deliveryOption.findFirst.mockResolvedValue({ id: OPTION_ID });
    stub.deliveryOption.update.mockResolvedValue(optionRow());

    await updateDeliveryOption(
      STORE_ID,
      OPTION_ID,
      { baseFee: "2500", isActive: false },
      undefined,
    );

    expect(stub.deliveryOption.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: OPTION_ID },
        data: expect.objectContaining({ baseFee: "2500.00", isActive: false }),
      }),
    );
  });
});

describe("deleteDeliveryOption (unit)", () => {
  it("404s an unknown option", async () => {
    stub.deliveryOption.findFirst.mockResolvedValue(null);

    await expect(deleteDeliveryOption(STORE_ID, OPTION_ID, undefined)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(stub.deliveryOption.delete).not.toHaveBeenCalled();
  });

  it("deletes the option", async () => {
    stub.deliveryOption.findFirst.mockResolvedValue({ id: OPTION_ID });
    stub.deliveryOption.delete.mockResolvedValue({ id: OPTION_ID });

    await deleteDeliveryOption(STORE_ID, OPTION_ID, undefined);

    expect(stub.deliveryOption.delete).toHaveBeenCalledWith({ where: { id: OPTION_ID } });
  });
});
