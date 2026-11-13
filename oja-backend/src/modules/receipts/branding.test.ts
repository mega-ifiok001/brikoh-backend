import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({ getPrismaClient: prismaMocks.getPrismaClient }));

import { loadMerchantBranding } from "./branding.js";

type PrismaStub = { store: { findUnique: Mock } };

const STORE_ID = "store-1";

function storeRow(overrides: Record<string, unknown> = {}) {
  return {
    name: "Mama Ade Stores",
    businessPhone: "+2348012345678",
    location: "12 Market Road, Lagos",
    currency: "NGN",
    customDomain: null,
    subdomain: "mama-ade",
    storefrontSettings: null,
    templateSettings: null,
    owner: { account: { email: "owner@example.com" } },
    ...overrides,
  };
}

let prisma: PrismaStub;

beforeEach(() => {
  prisma = { store: { findUnique: vi.fn() } };
  prismaMocks.getPrismaClient.mockReturnValue(prisma as never);
});

describe("loadMerchantBranding (unit)", () => {
  it("returns the store identity + owner reply-to", async () => {
    prisma.store.findUnique.mockResolvedValue(storeRow());

    const branding = await loadMerchantBranding(STORE_ID);

    expect(branding).toMatchObject({
      storeName: "Mama Ade Stores",
      address: "12 Market Road, Lagos",
      phone: "+2348012345678",
      currency: "NGN",
      replyTo: "owner@example.com",
      accentColor: "#18181b",
      logoUrl: null,
    });
    expect(branding.socialLinks).toEqual({ instagram: null, facebook: null, tiktok: null });
  });

  it("prefers the template accent + logo over storefront settings", async () => {
    prisma.store.findUnique.mockResolvedValue(
      storeRow({
        templateSettings: { accentColor: "#2563eb", logoUrl: "https://cdn.example.com/logo.png" },
        storefrontSettings: { accentColor: "#16a34a" },
      }),
    );

    const branding = await loadMerchantBranding(STORE_ID);

    expect(branding.accentColor).toBe("#2563eb");
    expect(branding.logoUrl).toBe("https://cdn.example.com/logo.png");
  });

  it("falls back to the storefront accent when the template has none", async () => {
    prisma.store.findUnique.mockResolvedValue(
      storeRow({ storefrontSettings: { accentColor: "#16a34a" } }),
    );

    expect((await loadMerchantBranding(STORE_ID)).accentColor).toBe("#16a34a");
  });

  it("reads social links from storefront settings", async () => {
    prisma.store.findUnique.mockResolvedValue(
      storeRow({
        storefrontSettings: {
          socialLinks: {
            instagram: "https://instagram.com/mamaade",
            facebook: null,
            tiktok: null,
          },
        },
      }),
    );

    const branding = await loadMerchantBranding(STORE_ID);
    expect(branding.socialLinks.instagram).toBe("https://instagram.com/mamaade");
  });

  it("uses the custom domain for the storefront URL when set", async () => {
    prisma.store.findUnique.mockResolvedValue(storeRow({ customDomain: "mamaade.com" }));

    expect((await loadMerchantBranding(STORE_ID)).storefrontUrl).toBe("https://mamaade.com");
  });

  it("builds the storefront URL from the subdomain + frontend apex otherwise", async () => {
    prisma.store.findUnique.mockResolvedValue(storeRow({ subdomain: "mama-ade" }));

    // The test env's FRONTEND_URL is https://brikoh.com (a bare apex).
    expect((await loadMerchantBranding(STORE_ID)).storefrontUrl).toBe(
      "https://mama-ade.brikoh.com",
    );
  });

  it("returns a null reply-to when the store has no owner email", async () => {
    prisma.store.findUnique.mockResolvedValue(storeRow({ owner: null }));

    expect((await loadMerchantBranding(STORE_ID)).replyTo).toBeNull();
  });

  it("throws 404 when the store does not exist", async () => {
    prisma.store.findUnique.mockResolvedValue(null);

    await expect(loadMerchantBranding(STORE_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
