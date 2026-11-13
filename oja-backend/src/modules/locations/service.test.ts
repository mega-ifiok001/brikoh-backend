import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../lib/AppError.js";

// Prisma is stubbed at the module boundary, matching the products-service
// unit-test pattern: getPrismaClient() resolves to an in-memory stub.
const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

import { createLocation, listLocations } from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  store: { findUnique: Mock };
  subscription: { findUnique: Mock };
  location: { create: Mock; findMany: Mock; count: Mock };
}

const STORE_ID = "store-1";

function createStub(): PrismaStub {
  const stub: PrismaStub = {
    store: { findUnique: vi.fn().mockResolvedValue({ id: STORE_ID, subscriptionId: null }) },
    subscription: { findUnique: vi.fn().mockResolvedValue(null) },
    location: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
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

function locationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "location-1",
    storeId: STORE_ID,
    name: "Lagos Flagship",
    address: null,
    createdAt: new Date("2026-08-05T10:00:00Z"),
    updatedAt: new Date("2026-08-05T10:00:00Z"),
    ...overrides,
  };
}

let stub: PrismaStub;

function attachSubscription(overrides: Record<string, unknown> = {}) {
  stub.store.findUnique.mockResolvedValue({ id: STORE_ID, subscriptionId: "sub-1" });
  stub.subscription.findUnique.mockResolvedValue(subscriptionRow({ locationCap: 2, ...overrides }));
}

beforeEach(() => {
  stub = createStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub);
});

describe("createLocation (unit)", () => {
  it("creates a location when count < cap (under)", async () => {
    attachSubscription();
    stub.location.count.mockResolvedValue(1); // 1 location exists, cap 2
    stub.location.create.mockResolvedValue(locationRow());

    const result = await createLocation(STORE_ID, { name: "Abeokuta Branch" });

    expect(stub.location.count).toHaveBeenCalledWith({ where: { storeId: STORE_ID } });
    expect(stub.location.create).toHaveBeenCalledWith({
      data: { storeId: STORE_ID, name: "Abeokuta Branch", address: null },
    });
    expect(result.name).toBe("Lagos Flagship");
  });

  it("persists an optional address and trims the name", async () => {
    attachSubscription();
    stub.location.count.mockResolvedValue(0);
    stub.location.create.mockResolvedValue(locationRow());

    await createLocation(STORE_ID, { name: "  Abeokuta  ", address: "12 Lagos Rd" });

    expect(stub.location.create).toHaveBeenCalledWith({
      data: { storeId: STORE_ID, name: "Abeokuta", address: "12 Lagos Rd" },
    });
  });

  it("rejects exactly at the cap (count == cap) with LOCATION_LIMIT_REACHED", async () => {
    attachSubscription();
    stub.location.count.mockResolvedValue(2); // at cap 2

    await expect(createLocation(STORE_ID, { name: "Ibadan" })).rejects.toMatchObject({
      statusCode: 409,
      code: "LOCATION_LIMIT_REACHED",
    });
    expect(stub.location.create).not.toHaveBeenCalled();
  });

  it("rejects over the cap with an upgrade-promoting message", async () => {
    attachSubscription();
    stub.location.count.mockResolvedValue(3); // over cap 2 — a concurrent/legacy create

    await expect(createLocation(STORE_ID, { name: "Kano" })).rejects.toMatchObject({
      statusCode: 409,
      code: "LOCATION_LIMIT_REACHED",
    });
    try {
      await createLocation(STORE_ID, { name: "Kano" });
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).message).toMatch(/upgrade to PRO/i);
      expect((err as AppError).message).not.toMatch(/internal/i);
    }
  });

  it("suggests ENTERPRISE when the current tier is PRO", async () => {
    attachSubscription({ tier: "PRO" });
    stub.location.count.mockResolvedValue(3); // PRO tier cap 3, already at it

    try {
      await createLocation(STORE_ID, { name: "Port Harcourt" });
      throw new Error("unreachable");
    } catch (err) {
      expect((err as AppError).message).toMatch(/upgrade to ENTERPRISE/i);
    }
  });

  it("is unlimited when the store has no subscription", async () => {
    // stub defaults: subscriptionId null
    stub.location.count.mockResolvedValue(99999);
    stub.location.create.mockResolvedValue(locationRow());

    await createLocation(STORE_ID, { name: "Enugu" });
    expect(stub.location.count).not.toHaveBeenCalled();
    expect(stub.location.create).toHaveBeenCalled();
  });

  it("is unlimited when the effective cap is null (edge)", async () => {
    attachSubscription({ locationCap: null, tier: "ENTERPRISE" }); // ENTERPRISE tier default has no location cap
    stub.location.count.mockResolvedValue(9999);
    stub.location.create.mockResolvedValue(locationRow());

    await createLocation(STORE_ID, { name: "Onitsha" });
    expect(stub.location.count).not.toHaveBeenCalled();
    expect(stub.location.create).toHaveBeenCalled();
  });

  it("uses the tier-default cap when the row cap is null", async () => {
    attachSubscription({ locationCap: null, tier: "STARTER" }); // STARTER default locationCap = 1
    stub.location.count.mockResolvedValue(1); // exactly at the default (1) → rejected

    await expect(createLocation(STORE_ID, { name: "Calabar" })).rejects.toMatchObject({
      statusCode: 409,
      code: "LOCATION_LIMIT_REACHED",
    });
    expect(stub.location.create).not.toHaveBeenCalled();
  });

  it("rejects a blank name with a validation error", async () => {
    await expect(createLocation(STORE_ID, { name: "   " })).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
    expect(stub.location.create).not.toHaveBeenCalled();
  });
});

describe("listLocations (unit)", () => {
  it("returns the tenant's locations, oldest first, and is tenant-scoped", async () => {
    stub.location.findMany.mockResolvedValue([locationRow()]);

    const result = await listLocations(STORE_ID);

    expect(stub.location.findMany).toHaveBeenCalledWith({
      where: { storeId: STORE_ID },
      orderBy: { createdAt: "asc" },
    });
    expect(result).toHaveLength(1);
  });
});
