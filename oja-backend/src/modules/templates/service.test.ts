import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PrismaClient,
  Subscription as SubscriptionRow,
} from "../../../generated/prisma/client.js";
import { Prisma } from "../../../generated/prisma/client.js";

// Prisma is stubbed at the module boundary: every service and middleware
// resolves the client via getPrismaClient(), so unit tests swap in a stub
// without touching the real database.
const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

import {
  getTemplateCatalog,
  listVisibleTemplates,
  normalizeSettings,
  resolveOnboardingTemplateId,
  resolveTemplateVisibility,
  selectStoreTemplate,
  setStoreTemplateSettings,
} from "./service.js";
import { templateSettingsSchema } from "./schemas.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  account: { findUnique: Mock };
  store: { findUnique: Mock; update: Mock };
  subscription: { findUnique: Mock };
  storeTemplate: { findMany: Mock };
}

function createStub(): PrismaStub {
  return {
    account: { findUnique: vi.fn() },
    store: { findUnique: vi.fn(), update: vi.fn() },
    subscription: { findUnique: vi.fn() },
    storeTemplate: { findMany: vi.fn() },
  };
}

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "tmpl-1",
    slug: "market",
    name: "Market Classic",
    description: null,
    previewUrl: null,
    sortOrder: 1,
    isActive: true,
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    updatedAt: new Date("2026-08-11T00:00:00.000Z"),
    ...overrides,
  };
}

function subscriptionRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-1",
    storeId: "store-1",
    tier: "STARTER",
    status: "ACTIVE",
    currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
    currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
    staffCap: null,
    locationCap: null,
    productCap: null,
    orderCap: null,
    templateCap: null,
    pendingDowngradeTier: null,
    pastDueAt: null,
    paystackSubscriptionCode: null,
    paystackPlanCode: null,
    paystackEmailToken: null,
    legacyPaystackSubscriptionCode: null,
    legacyPaystackPlanCode: null,
    swapPending: false,
    renewalCount: 0,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

const EIGHT_TEMPLATES = Array.from({ length: 8 }, (_, i) =>
  templateRow({ id: `tmpl-${i + 1}`, slug: `slug-${i + 1}`, sortOrder: i + 1 }),
);

let stub: PrismaStub;

beforeEach(() => {
  stub = createStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
});

describe("resolveTemplateVisibility (unit)", () => {
  it("treats a null subscription (pre-onboarding) as the STARTER set of 3", () => {
    expect(resolveTemplateVisibility(null)).toEqual({ tier: "STARTER", visibleCount: 3 });
  });

  it("maps an ACTIVE STARTER subscription to 3", () => {
    expect(resolveTemplateVisibility(subscriptionRow({ tier: "STARTER" }))).toEqual({
      tier: "STARTER",
      visibleCount: 3,
    });
  });

  it("maps an ACTIVE PRO subscription to 5", () => {
    expect(resolveTemplateVisibility(subscriptionRow({ tier: "PRO" }))).toEqual({
      tier: "PRO",
      visibleCount: 5,
    });
  });

  it("maps an ACTIVE ENTERPRISE subscription to Infinity (all)", () => {
    expect(resolveTemplateVisibility(subscriptionRow({ tier: "ENTERPRISE" }))).toEqual({
      tier: "ENTERPRISE",
      visibleCount: Infinity,
    });
  });

  it("degrades an inactive subscription (PAST_DUE/CANCELLED) to the STARTER set", () => {
    expect(resolveTemplateVisibility(subscriptionRow({ tier: "PRO", status: "PAST_DUE" }))).toEqual(
      { tier: "STARTER", visibleCount: 3 },
    );
    expect(
      resolveTemplateVisibility(subscriptionRow({ tier: "ENTERPRISE", status: "CANCELLED" })),
    ).toEqual({ tier: "STARTER", visibleCount: 3 });
  });

  it("lets a non-null row templateCap override the tier default", () => {
    expect(resolveTemplateVisibility(subscriptionRow({ tier: "STARTER", templateCap: 2 }))).toEqual(
      { tier: "STARTER", visibleCount: 2 },
    );
    expect(resolveTemplateVisibility(subscriptionRow({ tier: "PRO", templateCap: 4 }))).toEqual({
      tier: "PRO",
      visibleCount: 4,
    });
  });
});

describe("listVisibleTemplates (unit)", () => {
  it("slices the catalog to the tier count — STARTER sees the first 3 of 8", async () => {
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);
    const visible = await listVisibleTemplates(subscriptionRow({ tier: "STARTER" }));
    expect(visible.map((t) => t.id)).toEqual(["tmpl-1", "tmpl-2", "tmpl-3"]);
  });

  it("PRO sees the first 5 (a superset — STARTER's set is never hidden)", async () => {
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);
    const visible = await listVisibleTemplates(subscriptionRow({ tier: "PRO" }));
    expect(visible.map((t) => t.id)).toEqual(["tmpl-1", "tmpl-2", "tmpl-3", "tmpl-4", "tmpl-5"]);
  });

  it("ENTERPRISE sees every active template", async () => {
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);
    const visible = await listVisibleTemplates(subscriptionRow({ tier: "ENTERPRISE" }));
    expect(visible).toHaveLength(8);
  });

  it("fetches only active templates, ordered by sortOrder ascending", async () => {
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);
    await listVisibleTemplates(null);
    expect(stub.storeTemplate.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
  });
});

describe("getTemplateCatalog (unit)", () => {
  it("returns the pre-subscription STARTER set for a tenant-less account (pre-onboarding)", async () => {
    stub.account.findUnique.mockResolvedValue({ owner: null, staffMembers: [] });
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);

    const catalog = await getTemplateCatalog("account-1");

    expect(catalog.tier).toBe("STARTER");
    expect(catalog.visibleCount).toBe(3);
    expect(catalog.templates).toHaveLength(3);
    expect(catalog.selectedTemplateId).toBeNull();
    expect(stub.store.findUnique).not.toHaveBeenCalled();
  });

  it("reports settings null until the store is customized", async () => {
    stub.account.findUnique.mockResolvedValue({
      owner: { storeId: "store-1" },
      staffMembers: [],
    });
    stub.store.findUnique.mockResolvedValue({
      id: "store-1",
      subscriptionId: null,
      templateId: null,
      templateSettings: null,
    });
    stub.subscription.findUnique.mockResolvedValue(null);
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);

    const catalog = await getTemplateCatalog("account-1");

    expect(catalog.settings).toBeNull();
  });

  it("normalizes the store's saved customization into the full settings shape", async () => {
    stub.account.findUnique.mockResolvedValue({
      owner: { storeId: "store-1" },
      staffMembers: [],
    });
    stub.store.findUnique.mockResolvedValue({
      id: "store-1",
      subscriptionId: null,
      templateId: null,
      templateSettings: { accentColor: "#B45309", announcementBar: { enabled: true, text: "Hi" } },
    });
    stub.subscription.findUnique.mockResolvedValue(null);
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);

    const catalog = await getTemplateCatalog("account-1");

    expect(catalog.settings).toEqual({
      accentColor: "#B45309",
      logoUrl: null,
      heroText: null,
      heroSubtext: null,
      announcementBar: { enabled: true, text: "Hi" },
    });
  });

  it("resolves the tier from the account's store subscription once onboarded", async () => {
    stub.account.findUnique.mockResolvedValue({
      owner: { storeId: "store-1" },
      staffMembers: [],
    });
    stub.store.findUnique.mockResolvedValue({
      id: "store-1",
      subscriptionId: null,
      templateId: "tmpl-1",
    });
    stub.subscription.findUnique.mockResolvedValue(null);
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);

    const catalog = await getTemplateCatalog("account-1");

    expect(catalog.tier).toBe("STARTER");
    expect(catalog.selectedTemplateId).toBe("tmpl-1");
  });

  it("reports the store's selection alongside a PRO-tier catalog", async () => {
    stub.account.findUnique.mockResolvedValue({
      owner: { storeId: "store-1" },
      staffMembers: [],
    });
    stub.store.findUnique.mockResolvedValue({
      id: "store-1",
      subscriptionId: "sub-1",
      templateId: "tmpl-4",
    });
    stub.subscription.findUnique.mockResolvedValue(subscriptionRow({ tier: "PRO" }));
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);

    const catalog = await getTemplateCatalog("account-1");

    expect(catalog.tier).toBe("PRO");
    expect(catalog.templates).toHaveLength(5);
    expect(catalog.selectedTemplateId).toBe("tmpl-4");
  });

  it("rejects an unknown account with UNAUTHORIZED (401)", async () => {
    stub.account.findUnique.mockResolvedValue(null);
    await expect(getTemplateCatalog("ghost")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      statusCode: 401,
    });
  });
});

describe("selectStoreTemplate (unit)", () => {
  it("persists a template that is in the store's visible set", async () => {
    stub.store.findUnique.mockResolvedValue({ id: "store-1", subscriptionId: null });
    stub.subscription.findUnique.mockResolvedValue(null);
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);
    stub.store.update.mockResolvedValue({ id: "store-1", templateId: "tmpl-3" });

    const result = await selectStoreTemplate("store-1", "tmpl-3");

    expect(stub.store.update).toHaveBeenCalledWith({
      where: { id: "store-1" },
      data: { templateId: "tmpl-3" },
    });
    expect(result.template.id).toBe("tmpl-3");
  });

  it("rejects a template beyond the tier count BEFORE any write (400 TEMPLATE_NOT_AVAILABLE)", async () => {
    stub.store.findUnique.mockResolvedValue({ id: "store-1", subscriptionId: null });
    stub.subscription.findUnique.mockResolvedValue(null);
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);

    await expect(selectStoreTemplate("store-1", "tmpl-5")).rejects.toMatchObject({
      code: "TEMPLATE_NOT_AVAILABLE",
      statusCode: 400,
    });
    expect(stub.store.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown template id (400 TEMPLATE_NOT_AVAILABLE)", async () => {
    stub.store.findUnique.mockResolvedValue({ id: "store-1", subscriptionId: null });
    stub.subscription.findUnique.mockResolvedValue(null);
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);

    await expect(selectStoreTemplate("store-1", "tmpl-99")).rejects.toMatchObject({
      code: "TEMPLATE_NOT_AVAILABLE",
      statusCode: 400,
    });
  });
});

describe("resolveOnboardingTemplateId (unit)", () => {
  it("defaults to the first visible template when omitted", async () => {
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);
    await expect(resolveOnboardingTemplateId(undefined)).resolves.toBe("tmpl-1");
  });

  it("accepts a template inside the pre-subscription STARTER set", async () => {
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);
    await expect(resolveOnboardingTemplateId("tmpl-3")).resolves.toBe("tmpl-3");
  });

  it("rejects a template beyond the STARTER set (400 TEMPLATE_NOT_AVAILABLE)", async () => {
    stub.storeTemplate.findMany.mockResolvedValue(EIGHT_TEMPLATES);
    await expect(resolveOnboardingTemplateId("tmpl-4")).rejects.toMatchObject({
      code: "TEMPLATE_NOT_AVAILABLE",
      statusCode: 400,
    });
  });

  it("surfaces a clear 500 when the catalog is empty and no default exists", async () => {
    stub.storeTemplate.findMany.mockResolvedValue([]);
    await expect(resolveOnboardingTemplateId(undefined)).rejects.toMatchObject({
      code: "TEMPLATES_UNAVAILABLE",
      statusCode: 500,
    });
  });
});

describe("setStoreTemplateSettings (unit)", () => {
  it("persists the provided fields and strips nulls (replace semantics)", async () => {
    stub.store.update.mockResolvedValue({ id: "store-1", templateSettings: null });

    const result = await setStoreTemplateSettings("store-1", {
      accentColor: "#B45309",
      logoUrl: null,
      heroText: "Fresh from Lagos",
      heroSubtext: undefined,
      announcementBar: { enabled: true, text: "Free delivery" },
    });

    expect(stub.store.update).toHaveBeenCalledWith({
      where: { id: "store-1" },
      data: {
        templateSettings: {
          accentColor: "#B45309",
          heroText: "Fresh from Lagos",
          announcementBar: { enabled: true, text: "Free delivery" },
        },
      },
    });
    expect(result.settings).toEqual({
      accentColor: "#B45309",
      logoUrl: null,
      heroText: "Fresh from Lagos",
      heroSubtext: null,
      announcementBar: { enabled: true, text: "Free delivery" },
    });
  });

  it("stores SQL NULL when everything is cleared ({} resets to template defaults)", async () => {
    stub.store.update.mockResolvedValue({ id: "store-1", templateSettings: null });

    const result = await setStoreTemplateSettings("store-1", {});

    expect(stub.store.update).toHaveBeenCalledWith({
      where: { id: "store-1" },
      data: { templateSettings: Prisma.DbNull },
    });
    expect(result.settings).toBeNull();
  });
});

describe("normalizeSettings (unit)", () => {
  it("maps null (never customized) to null", () => {
    expect(normalizeSettings(null)).toBeNull();
  });

  it("fills the full shape with nulls for absent keys", () => {
    expect(normalizeSettings({ accentColor: "#B45309" })).toEqual({
      accentColor: "#B45309",
      logoUrl: null,
      heroText: null,
      heroSubtext: null,
      announcementBar: null,
    });
  });

  it("degrades malformed stored shapes gracefully instead of throwing", () => {
    expect(normalizeSettings("oops")).toBeNull();
    expect(normalizeSettings([1, 2])).toBeNull();
    expect(normalizeSettings({ announcementBar: "nope", accentColor: 42 })).toEqual({
      accentColor: null,
      logoUrl: null,
      heroText: null,
      heroSubtext: null,
      announcementBar: null,
    });
  });
});

describe("templateSettingsSchema (unit)", () => {
  it("accepts a full valid payload", () => {
    const parsed = templateSettingsSchema.safeParse({
      accentColor: "#B45309",
      logoUrl: "https://cdn.example.com/logo.png",
      heroText: "Fresh from Lagos",
      heroSubtext: "Handpicked goods, delivered daily",
      announcementBar: { enabled: true, text: "Free delivery on orders over ₦50,000" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an empty body (clear everything)", () => {
    expect(templateSettingsSchema.safeParse({}).success).toBe(true);
  });

  it("rejects a malformed hex color", () => {
    const parsed = templateSettingsSchema.safeParse({
      accentColor: "B45309",
      announcementBar: null,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0]!.message).toContain("hex");
  });

  it("rejects a non-https logoUrl", () => {
    const parsed = templateSettingsSchema.safeParse({
      logoUrl: "http://cdn.example.com/logo.png",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0]!.message).toContain("https");
  });

  it("rejects unknown keys (misspelled fields do not silently vanish)", () => {
    const parsed = templateSettingsSchema.safeParse({
      accentColour: "#B45309",
      heroText: "Fresh from Lagos",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0]!.code).toBe("unrecognized_keys");
  });

  it("rejects over-length heroText", () => {
    expect(templateSettingsSchema.safeParse({ heroText: "x".repeat(81) }).success).toBe(false);
  });

  it("rejects a malformed announcementBar (missing text, extra keys)", () => {
    expect(templateSettingsSchema.safeParse({ announcementBar: { enabled: true } }).success).toBe(
      false,
    );
    expect(
      templateSettingsSchema.safeParse({ announcementBar: { enabled: true, text: "Hi", oops: 1 } })
        .success,
    ).toBe(false);
  });
});
