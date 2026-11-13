import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

const activityMocks = vi.hoisted(() => ({ logStoreActivity: vi.fn() }));
vi.mock("../activity/service.js", () => ({
  logStoreActivity: activityMocks.logStoreActivity,
}));

import {
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
} from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  campaign: {
    findMany: Mock;
    create: Mock;
    findFirst: Mock;
    updateMany: Mock;
    deleteMany: Mock;
    findUniqueOrThrow: Mock;
  };
  discount: { findFirst: Mock };
}

const STORE_ID = "c0000000-0000-4000-8000-000000000001";
const CAMPAIGN_ID = "c0000000-0000-4000-8000-000000000002";
const DISCOUNT_ID = "c0000000-0000-4000-8000-000000000003";
const STAFF_ID = "c0000000-0000-4000-8000-000000000004";

const CAMPAIGN_ROW = {
  id: CAMPAIGN_ID,
  storeId: STORE_ID,
  name: "August Clearance",
  startsAt: new Date("2026-08-20T00:00:00.000Z"),
  endsAt: new Date("2026-09-01T00:00:00.000Z"),
  bannerTitle: "August Clearance",
  bannerSubtitle: "Up to 20% off everything",
  ctaLabel: "Shop now",
  discountId: DISCOUNT_ID,
  discount: { code: "AUGUST20" },
  isActive: true,
  createdAt: new Date("2026-08-19T10:00:00.000Z"),
  updatedAt: new Date("2026-08-19T10:00:00.000Z"),
};

function createPrismaStub(): PrismaStub {
  return {
    campaign: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    discount: { findFirst: vi.fn() },
  };
}

beforeEach(() => {
  activityMocks.logStoreActivity.mockReset();
});

describe("listCampaigns", () => {
  it("returns an empty page when no campaigns match", async () => {
    const stub = createPrismaStub();
    stub.campaign.findMany.mockResolvedValue([]);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    const page = await listCampaigns(STORE_ID, { limit: "50" });

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(stub.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: STORE_ID } }),
    );
  });

  it("maps rows with the linked discount code and applies the isActive filter", async () => {
    const stub = createPrismaStub();
    stub.campaign.findMany.mockResolvedValue([CAMPAIGN_ROW]);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    const page = await listCampaigns(STORE_ID, { isActive: "true", limit: "50" });

    expect(page.items[0]).toEqual({
      id: CAMPAIGN_ID,
      name: "August Clearance",
      startsAt: CAMPAIGN_ROW.startsAt,
      endsAt: CAMPAIGN_ROW.endsAt,
      bannerTitle: "August Clearance",
      bannerSubtitle: "Up to 20% off everything",
      ctaLabel: "Shop now",
      discountId: DISCOUNT_ID,
      discountCode: "AUGUST20",
      isActive: true,
      createdAt: CAMPAIGN_ROW.createdAt,
      updatedAt: CAMPAIGN_ROW.updatedAt,
    });
    expect(page.nextCursor).toBeNull();
    expect(stub.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: STORE_ID, isActive: true } }),
    );
  });

  it("computes nextCursor on a full page", async () => {
    const stub = createPrismaStub();
    stub.campaign.findMany.mockResolvedValue([{ ...CAMPAIGN_ROW, id: "id-a" }]);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    const page = await listCampaigns(STORE_ID, { limit: "1" });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe("id-a");
  });

  it("maps null discountCode for unlinked campaigns", async () => {
    const stub = createPrismaStub();
    stub.campaign.findMany.mockResolvedValue([
      { ...CAMPAIGN_ROW, discountId: null, discount: null },
    ]);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    const page = await listCampaigns(STORE_ID, {});

    expect(page.items[0]!.discountId).toBeNull();
    expect(page.items[0]!.discountCode).toBeNull();
  });
});

describe("createCampaign", () => {
  it("creates the campaign and logs campaign.created", async () => {
    const stub = createPrismaStub();
    stub.campaign.create.mockResolvedValue(CAMPAIGN_ROW);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    const campaign = await createCampaign(STORE_ID, STAFF_ID, {
      name: "August Clearance",
      bannerTitle: "August Clearance",
      ctaLabel: "Shop now",
    });

    expect(campaign.name).toBe("August Clearance");
    expect(stub.campaign.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storeId: STORE_ID, name: "August Clearance" }),
      }),
    );
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        storeId: STORE_ID,
        staffMemberId: STAFF_ID,
        action: "campaign.created",
        detail: expect.objectContaining({ campaignId: CAMPAIGN_ID, name: "August Clearance" }),
      }),
    );
  });

  it("links a coupon when discountId is provided and belongs to the store", async () => {
    const stub = createPrismaStub();
    stub.discount.findFirst.mockResolvedValue({ id: DISCOUNT_ID, storeId: STORE_ID });
    stub.campaign.create.mockResolvedValue(CAMPAIGN_ROW);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    await createCampaign(STORE_ID, STAFF_ID, { name: "August Clearance", discountId: DISCOUNT_ID });

    expect(stub.discount.findFirst).toHaveBeenCalledWith({
      where: { id: DISCOUNT_ID, storeId: STORE_ID },
      select: { id: true },
    });
    expect(stub.campaign.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ discountId: DISCOUNT_ID }) }),
    );
  });

  it("rejects a cross-tenant or unknown discountId with DISCOUNT_NOT_FOUND", async () => {
    const stub = createPrismaStub();
    stub.discount.findFirst.mockResolvedValue(null);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    await expect(
      createCampaign(STORE_ID, STAFF_ID, { name: "August Clearance", discountId: DISCOUNT_ID }),
    ).rejects.toMatchObject({ code: "DISCOUNT_NOT_FOUND" });
    expect(stub.campaign.create).not.toHaveBeenCalled();
  });
});

describe("getCampaign", () => {
  it("returns one campaign", async () => {
    const stub = createPrismaStub();
    stub.campaign.findFirst.mockResolvedValue(CAMPAIGN_ROW);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    const campaign = await getCampaign(STORE_ID, CAMPAIGN_ID);

    expect(campaign.id).toBe(CAMPAIGN_ID);
    expect(stub.campaign.findFirst).toHaveBeenCalledWith({
      where: { id: CAMPAIGN_ID, storeId: STORE_ID },
      include: { discount: { select: { code: true } } },
    });
  });

  it("throws CAMPAIGN_NOT_FOUND for unknown or cross-tenant ids", async () => {
    const stub = createPrismaStub();
    stub.campaign.findFirst.mockResolvedValue(null);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    await expect(getCampaign(STORE_ID, CAMPAIGN_ID)).rejects.toMatchObject({
      code: "CAMPAIGN_NOT_FOUND",
    });
  });
});

describe("updateCampaign", () => {
  it("updates only the provided fields and logs campaign.updated", async () => {
    const stub = createPrismaStub();
    stub.campaign.updateMany.mockResolvedValue({ count: 1 });
    stub.campaign.findUniqueOrThrow.mockResolvedValue(CAMPAIGN_ROW);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    const campaign = await updateCampaign(STORE_ID, STAFF_ID, CAMPAIGN_ID, {
      bannerSubtitle: "New subtitle",
    });

    expect(campaign.bannerSubtitle).toBe("Up to 20% off everything");
    expect(stub.campaign.updateMany).toHaveBeenCalledWith({
      where: { id: CAMPAIGN_ID, storeId: STORE_ID },
      data: { bannerSubtitle: "New subtitle" },
    });
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "campaign.updated",
        detail: expect.objectContaining({ campaignId: CAMPAIGN_ID }),
      }),
    );
  });

  it("throws CAMPAIGN_NOT_FOUND when nothing matched", async () => {
    const stub = createPrismaStub();
    stub.campaign.updateMany.mockResolvedValue({ count: 0 });
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    await expect(
      updateCampaign(STORE_ID, STAFF_ID, CAMPAIGN_ID, { name: "Renamed" }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_NOT_FOUND" });
  });

  it("rejects a cross-tenant discountId on update", async () => {
    const stub = createPrismaStub();
    stub.discount.findFirst.mockResolvedValue(null);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    await expect(
      updateCampaign(STORE_ID, STAFF_ID, CAMPAIGN_ID, { discountId: DISCOUNT_ID }),
    ).rejects.toMatchObject({ code: "DISCOUNT_NOT_FOUND" });
    expect(stub.campaign.updateMany).not.toHaveBeenCalled();
  });
});

describe("deleteCampaign", () => {
  it("deletes and logs campaign.deleted", async () => {
    const stub = createPrismaStub();
    stub.campaign.deleteMany.mockResolvedValue({ count: 1 });
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    await deleteCampaign(STORE_ID, STAFF_ID, CAMPAIGN_ID);

    expect(stub.campaign.deleteMany).toHaveBeenCalledWith({
      where: { id: CAMPAIGN_ID, storeId: STORE_ID },
    });
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "campaign.deleted",
        detail: expect.objectContaining({ campaignId: CAMPAIGN_ID }),
      }),
    );
  });

  it("throws CAMPAIGN_NOT_FOUND when nothing matched", async () => {
    const stub = createPrismaStub();
    stub.campaign.deleteMany.mockResolvedValue({ count: 0 });
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    await expect(deleteCampaign(STORE_ID, STAFF_ID, CAMPAIGN_ID)).rejects.toMatchObject({
      code: "CAMPAIGN_NOT_FOUND",
    });
  });
});
