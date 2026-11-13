import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

const activityMocks = vi.hoisted(() => ({ logStoreActivity: vi.fn() }));
vi.mock("../activity/service.js", () => ({
  logStoreActivity: activityMocks.logStoreActivity,
}));

import {
  getNotificationSettings,
  updateBusinessProfile,
  updateNotificationSettings,
} from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  $transaction: Mock;
  store: {
    findUnique: Mock;
    update: Mock;
  };
}

const STORE_ID = "store-1";

const PROFILE_ROW = {
  id: STORE_ID,
  name: "Ade Store",
  businessType: "RETAIL",
  location: "Lagos",
  currency: "NGN",
  businessPhone: "+2348012345678",
};

function createPrismaStub(): PrismaStub {
  const stub: PrismaStub = {
    $transaction: vi.fn(),
    store: { findUnique: vi.fn(), update: vi.fn() },
  };
  stub.$transaction.mockImplementation(async (fn: (tx: PrismaStub) => Promise<unknown>) =>
    fn(stub),
  );
  return stub;
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createPrismaStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  activityMocks.logStoreActivity.mockReset();
  activityMocks.logStoreActivity.mockResolvedValue(undefined);
});

describe("updateBusinessProfile (unit)", () => {
  it("persists the full profile and logs store.settings.updated", async () => {
    stub.store.update.mockResolvedValue(PROFILE_ROW);

    const result = await updateBusinessProfile(STORE_ID, undefined, {
      name: "Ade Store",
      businessType: "RETAIL",
      location: "Lagos",
      currency: "NGN",
      businessPhone: "+2348012345678",
    });

    expect(result).toEqual({
      storeId: STORE_ID,
      name: "Ade Store",
      businessType: "RETAIL",
      location: "Lagos",
      currency: "NGN",
      businessPhone: "+2348012345678",
    });
    expect(stub.store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: STORE_ID },
        data: expect.objectContaining({ name: "Ade Store", businessPhone: "+2348012345678" }),
      }),
    );
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(stub, {
      storeId: STORE_ID,
      staffMemberId: null,
      action: "store.settings.updated",
      detail: {
        fields: ["name", "businessType", "location", "currency", "businessPhone"],
      },
    });
  });

  it("defaults currency to NGN when omitted", async () => {
    stub.store.update.mockResolvedValue(PROFILE_ROW);

    await updateBusinessProfile(STORE_ID, undefined, {
      name: "Ade Store",
      businessType: "RETAIL",
      location: "Lagos",
      businessPhone: "+2348012345678",
    });

    const updateCall = stub.store.update.mock.calls[0]![0] as {
      data: { currency: string };
    };
    expect(updateCall.data.currency).toBe("NGN");
  });

  it("rejects an unknown field (strict schema)", async () => {
    stub.store.update.mockResolvedValue(PROFILE_ROW);

    await expect(
      updateBusinessProfile(STORE_ID, undefined, {
        name: "Ade Store",
        businessType: "RETAIL",
        location: "Lagos",
        businessPhone: "+2348012345678",
        staleField: "nope",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(stub.store.update).not.toHaveBeenCalled();
  });
});

describe("getNotificationSettings (unit)", () => {
  it("defaults every unset toggle to true", async () => {
    stub.store.findUnique.mockResolvedValue({ notificationSettings: null });

    expect(await getNotificationSettings(STORE_ID)).toEqual({
      lowStockAlerts: true,
      paymentAlerts: true,
      expiringSoonAlerts: true,
      receiptsEnabled: true,
    });
  });

  it("merges persisted toggles over the defaults", async () => {
    stub.store.findUnique.mockResolvedValue({
      notificationSettings: { lowStockAlerts: false },
    });

    expect(await getNotificationSettings(STORE_ID)).toEqual({
      lowStockAlerts: false,
      paymentAlerts: true,
      expiringSoonAlerts: true,
      receiptsEnabled: true,
    });
  });

  it("rejects an unknown store with NOT_FOUND", async () => {
    stub.store.findUnique.mockResolvedValue(null);

    await expect(getNotificationSettings(STORE_ID)).rejects.toMatchObject({
      code: "NOT_FOUND",
      statusCode: 404,
    });
    expect(stub.store.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: STORE_ID } }),
    );
  });
});

describe("updateNotificationSettings (unit)", () => {
  it("merges the patch over the current set and returns the full set", async () => {
    stub.store.findUnique.mockResolvedValue({
      notificationSettings: { lowStockAlerts: true },
    });
    stub.store.update.mockResolvedValue({ id: STORE_ID });

    const result = await updateNotificationSettings(STORE_ID, undefined, {
      paymentAlerts: false,
    });

    expect(result).toEqual({
      lowStockAlerts: true,
      paymentAlerts: false,
      expiringSoonAlerts: true,
      receiptsEnabled: true,
    });
    expect(stub.store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: STORE_ID },
        data: {
          notificationSettings: {
            lowStockAlerts: true,
            paymentAlerts: false,
            expiringSoonAlerts: true,
            receiptsEnabled: true,
          },
        },
      }),
    );
  });

  it("logs the toggled keys with staffMemberId", async () => {
    stub.store.findUnique.mockResolvedValue({ notificationSettings: {} });
    stub.store.update.mockResolvedValue({ id: STORE_ID });

    await updateNotificationSettings(STORE_ID, "staff-1", { expiringSoonAlerts: false });

    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(stub, {
      storeId: STORE_ID,
      staffMemberId: "staff-1",
      action: "store.settings.notifications.updated",
      detail: { toggles: ["expiringSoonAlerts"] },
    });
  });

  it("rejects an empty body and unknown keys", async () => {
    stub.store.findUnique.mockResolvedValue({ notificationSettings: {} });
    stub.store.update.mockResolvedValue({ id: STORE_ID });

    await expect(updateNotificationSettings(STORE_ID, undefined, {})).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      updateNotificationSettings(STORE_ID, undefined, { bogusToggle: true }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(stub.store.update).not.toHaveBeenCalled();
  });
});
