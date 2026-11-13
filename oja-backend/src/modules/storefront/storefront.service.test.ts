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

import { AppError } from "../../lib/AppError.js";
import { getPublicStorefront, getStorefrontSettings, updateStorefrontSettings } from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  $transaction: Mock;
  store: { findUnique: Mock; update: Mock };
  campaign: { findFirst: Mock };
  paymentCredential: { findUnique: Mock };
  bankAccount: { findFirst: Mock };
  deliveryOption: { findMany: Mock };
}

const STORE_ID = "c0000000-0000-4000-8000-000000000001";

function createPrismaStub(): PrismaStub {
  return {
    $transaction: vi.fn(),
    store: { findUnique: vi.fn(), update: vi.fn() },
    campaign: { findFirst: vi.fn() },
    paymentCredential: { findUnique: vi.fn() },
    bankAccount: { findFirst: vi.fn() },
    deliveryOption: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createPrismaStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  stub.store.findUnique.mockResolvedValue(null);
  stub.campaign.findFirst.mockResolvedValue(null);
  stub.paymentCredential.findUnique.mockResolvedValue(null);
  stub.bankAccount.findFirst.mockResolvedValue(null);
  activityMocks.logStoreActivity.mockReset();
  activityMocks.logStoreActivity.mockResolvedValue(undefined);
  stub.$transaction.mockImplementation(async (fn: (tx: PrismaStub) => Promise<unknown>) =>
    fn(stub),
  );
});

describe("getStorefrontSettings (unit)", () => {
  it("returns the complete default set when nothing is stored", async () => {
    stub.store.findUnique.mockResolvedValue({ storefrontSettings: null });

    const settings = await getStorefrontSettings(STORE_ID);

    expect(settings).toEqual({
      template: "CLASSIC",
      tagline: null,
      heroTitle: null,
      heroSubtitle: null,
      accentColor: "#18181b",
      whatsappButtonEnabled: false,
      whatsappNumber: null,
      showPoweredByBadge: true,
      ga4MeasurementId: null,
      socialLinks: { instagram: null, facebook: null, tiktok: null },
    });
  });

  it("merges stored values over the defaults", async () => {
    stub.store.findUnique.mockResolvedValue({
      storefrontSettings: {
        template: "MODERN",
        accentColor: "#16a34a",
        whatsappButtonEnabled: true,
      },
    });

    const settings = await getStorefrontSettings(STORE_ID);

    expect(settings.template).toBe("MODERN");
    expect(settings.accentColor).toBe("#16a34a");
    expect(settings.whatsappButtonEnabled).toBe(true);
    // Unset keys keep their defaults.
    expect(settings.tagline).toBeNull();
    expect(settings.showPoweredByBadge).toBe(true);
  });

  it("ignores unknown/hostile stored keys", async () => {
    stub.store.findUnique.mockResolvedValue({
      storefrontSettings: {
        template: "NEON",
        accentColor: "#ff0000",
        whatsappNumber: 42,
        tagline: "safe",
        socialLinks: { instagram: "https://ig.example.com/a" },
        injected: "nope",
      },
    });

    const settings = await getStorefrontSettings(STORE_ID);

    expect(settings.template).toBe("CLASSIC");
    expect(settings.accentColor).toBe("#18181b");
    expect(settings.whatsappNumber).toBeNull();
    expect(settings.tagline).toBe("safe");
    expect(settings.socialLinks.instagram).toBe("https://ig.example.com/a");
    expect((settings as Record<string, unknown>).injected).toBeUndefined();
  });

  it("throws 404 when the store is gone", async () => {
    await expect(getStorefrontSettings(STORE_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });
});

describe("updateStorefrontSettings (unit)", () => {
  it("merges partial updates and logs the changed fields", async () => {
    stub.store.findUnique.mockResolvedValue({ storefrontSettings: null });

    const merged = await updateStorefrontSettings(STORE_ID, "staff-1", {
      template: "BOLD",
      whatsappNumber: "+2348012345678",
    });

    expect(merged.template).toBe("BOLD");
    expect(merged.whatsappNumber).toBe("+2348012345678");
    expect(stub.store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { storefrontSettings: expect.objectContaining({ template: "BOLD" }) },
      }),
    );
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({
        storeId: STORE_ID,
        staffMemberId: "staff-1",
        action: "store.storefront.settings.updated",
        detail: { fields: ["template", "whatsappNumber"] },
      }),
    );
  });

  it("clears a nullable field when an explicit null is sent", async () => {
    stub.store.findUnique.mockResolvedValue({
      storefrontSettings: { tagline: "Fresh daily", heroTitle: "Hello" },
    });

    const merged = await updateStorefrontSettings(STORE_ID, undefined, { tagline: null });

    expect(merged.tagline).toBeNull();
    expect(merged.heroTitle).toBe("Hello");
  });

  it("merges social links per key without wiping the others", async () => {
    stub.store.findUnique.mockResolvedValue({
      storefrontSettings: { socialLinks: { instagram: "https://ig.example.com/a" } },
    });

    const merged = await updateStorefrontSettings(STORE_ID, undefined, {
      socialLinks: { tiktok: "https://tiktok.example.com/@x" },
    });

    expect(merged.socialLinks.instagram).toBe("https://ig.example.com/a");
    expect(merged.socialLinks.tiktok).toBe("https://tiktok.example.com/@x");
    expect(merged.socialLinks.facebook).toBeNull();
  });

  it("rejects an accent color outside the fixed swatch", async () => {
    stub.store.findUnique.mockResolvedValue({ storefrontSettings: null });

    await expect(
      updateStorefrontSettings(STORE_ID, undefined, { accentColor: "#ff0000" }),
    ).rejects.toBeInstanceOf(AppError);
    expect(stub.store.update).not.toHaveBeenCalled();
  });

  it("rejects unknown keys (strict schema)", async () => {
    stub.store.findUnique.mockResolvedValue({ storefrontSettings: null });

    await expect(
      updateStorefrontSettings(STORE_ID, undefined, { ga4MeasurementId: "G-123" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects an empty body", async () => {
    stub.store.findUnique.mockResolvedValue({ storefrontSettings: null });

    await expect(updateStorefrontSettings(STORE_ID, undefined, {})).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("rejects a malformed social URL", async () => {
    stub.store.findUnique.mockResolvedValue({ storefrontSettings: null });

    await expect(
      updateStorefrontSettings(STORE_ID, undefined, {
        socialLinks: { instagram: "not-a-url" },
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe("getPublicStorefront (unit)", () => {
  it("returns the narrow projection with the store name", async () => {
    stub.store.findUnique.mockResolvedValue({
      name: "Fresh Mart",
      subdomain: "fresh-mart",
      storefrontSettings: { template: "MODERN", accentColor: "#0d9488" },
    });

    const result = await getPublicStorefront(STORE_ID);

    expect(result).toMatchObject({
      storeName: "Fresh Mart",
      subdomain: "fresh-mart",
      template: "MODERN",
      accentColor: "#0d9488",
      whatsappButtonEnabled: false,
      campaign: null,
    });
  });

  it("returns the live campaign banner when one is active in the window", async () => {
    stub.store.findUnique.mockResolvedValue({
      name: "Fresh Mart",
      subdomain: "fresh-mart",
      storefrontSettings: null,
    });
    stub.campaign.findFirst.mockResolvedValue({
      bannerTitle: "August Clearance",
      bannerSubtitle: "Up to 20% off",
      ctaLabel: "Shop now",
    });

    const result = await getPublicStorefront(STORE_ID, new Date("2026-08-25T10:00:00.000Z"));

    expect(result.campaign).toEqual({
      bannerTitle: "August Clearance",
      bannerSubtitle: "Up to 20% off",
      ctaLabel: "Shop now",
    });
    expect(stub.campaign.findFirst).toHaveBeenCalledWith({
      where: {
        storeId: STORE_ID,
        isActive: true,
        OR: [
          { startsAt: null, endsAt: null },
          { startsAt: null, endsAt: { gt: new Date("2026-08-25T10:00:00.000Z") } },
          { startsAt: { lte: new Date("2026-08-25T10:00:00.000Z") }, endsAt: null },
          {
            startsAt: { lte: new Date("2026-08-25T10:00:00.000Z") },
            endsAt: { gt: new Date("2026-08-25T10:00:00.000Z") },
          },
        ],
      },
      select: { bannerTitle: true, bannerSubtitle: true, ctaLabel: true },
      orderBy: { createdAt: "desc" },
    });
  });

  it("throws 404 for a missing store", async () => {
    await expect(getPublicStorefront(STORE_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "STORE_NOT_FOUND",
    });
  });
});
