import type { $Enums, Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import {
  ACCENT_SWATCH,
  DEFAULT_STOREFRONT_SETTINGS,
  storefrontSettingsUpdateSchema,
  type AccentColor,
  type StorefrontSettings,
  type StorefrontSettingsUpdateInput,
} from "./schemas.js";

/**
 * ============================================================
 * STOREFRONT SETTINGS SERVICE
 * ============================================================
 * Persists what the public storefront renders (template, hero copy,
 * accent color, WhatsApp button, social links, badge toggle). Unset
 * keys default — the complete known set is always returned, and the
 * public storefront reads the same defaults through
 * getPublicStorefront. Owner-only in the routes; the service trusts
 * the caller's authority.
 */

/**
 * Merges stored raw JSON over the defaults with per-key type checks, so
 * hand-edited or legacy rows can never poison the response shape.
 */
function mergeStored(raw: unknown): StorefrontSettings {
  const result: StorefrontSettings = {
    template: DEFAULT_STOREFRONT_SETTINGS.template,
    tagline: DEFAULT_STOREFRONT_SETTINGS.tagline,
    heroTitle: DEFAULT_STOREFRONT_SETTINGS.heroTitle,
    heroSubtitle: DEFAULT_STOREFRONT_SETTINGS.heroSubtitle,
    accentColor: DEFAULT_STOREFRONT_SETTINGS.accentColor,
    whatsappButtonEnabled: DEFAULT_STOREFRONT_SETTINGS.whatsappButtonEnabled,
    whatsappNumber: DEFAULT_STOREFRONT_SETTINGS.whatsappNumber,
    showPoweredByBadge: DEFAULT_STOREFRONT_SETTINGS.showPoweredByBadge,
    ga4MeasurementId: DEFAULT_STOREFRONT_SETTINGS.ga4MeasurementId,
    socialLinks: { ...DEFAULT_STOREFRONT_SETTINGS.socialLinks },
  };

  if (typeof raw !== "object" || raw === null) return result;
  const stored = raw as Record<string, unknown>;

  if (stored.template === "CLASSIC" || stored.template === "MODERN" || stored.template === "BOLD") {
    result.template = stored.template;
  }
  for (const key of ["tagline", "heroTitle", "heroSubtitle"] as const) {
    if (typeof stored[key] === "string") result[key] = stored[key];
  }
  if (ACCENT_SWATCH.includes(stored.accentColor as AccentColor)) {
    result.accentColor = stored.accentColor as AccentColor;
  }
  if (typeof stored.whatsappButtonEnabled === "boolean") {
    result.whatsappButtonEnabled = stored.whatsappButtonEnabled;
  }
  if (typeof stored.whatsappNumber === "string") result.whatsappNumber = stored.whatsappNumber;
  if (typeof stored.showPoweredByBadge === "boolean") {
    result.showPoweredByBadge = stored.showPoweredByBadge;
  }
  if (typeof stored.ga4MeasurementId === "string") {
    result.ga4MeasurementId = stored.ga4MeasurementId;
  }
  if (typeof stored.socialLinks === "object" && stored.socialLinks !== null) {
    const social = stored.socialLinks as Record<string, unknown>;
    for (const key of ["instagram", "facebook", "tiktok"] as const) {
      if (typeof social[key] === "string") result.socialLinks[key] = social[key];
    }
  }
  return result;
}

/** Reads the store's settings, defaults merged for every unset key. */
export async function getStorefrontSettings(storeId: string): Promise<StorefrontSettings> {
  const store = await getPrismaClient().store.findUnique({
    where: { id: storeId },
    select: { storefrontSettings: true },
  });
  if (store === null) {
    throw new AppError(404, "NOT_FOUND", "Store not found");
  }
  return mergeStored(store.storefrontSettings);
}

/**
 * Merges the supplied keys into the store's settings (unknown keys and
 * out-of-swatch colors rejected by the schema) and returns the full
 * persisted set. An explicit null clears a nullable field to default.
 */
export async function updateStorefrontSettings(
  storeId: string,
  staffMemberId: string | undefined,
  input: unknown,
): Promise<StorefrontSettings> {
  const data = validateOrThrow(
    storefrontSettingsUpdateSchema,
    input,
  ) as StorefrontSettingsUpdateInput;
  const prisma = getPrismaClient();

  const current = await getStorefrontSettings(storeId);
  const merged: StorefrontSettings = {
    ...current,
    ...data,
    socialLinks: { ...current.socialLinks, ...data.socialLinks },
  };

  await prisma.$transaction(async (tx) => {
    await tx.store.update({
      where: { id: storeId },
      data: { storefrontSettings: merged as unknown as Prisma.InputJsonValue },
    });
    await logStoreActivity(tx, {
      storeId,
      staffMemberId: staffMemberId ?? null,
      action: "store.storefront.settings.updated",
      detail: { fields: Object.keys(data) },
    });
  });

  return merged;
}

/** What the public storefront renders — the narrow projection. */
export async function getPublicStorefront(
  storeId: string,
  now: Date = new Date(),
): Promise<
  { storeName: string; subdomain: string } & StorefrontSettings & {
      campaign: {
        bannerTitle: string | null;
        bannerSubtitle: string | null;
        ctaLabel: string | null;
      } | null;
      /**
       * Which checkout payment methods are actually usable. Lets the
       * storefront UI hide an option BEFORE the customer hits a dead-end
       * 409 (e.g. a store with no bank account configured can't offer
       * bank_transfer). Derived, never stored.
       */
      availablePaymentMethods: string[];
      /** The active fulfilment choices the buyer picks at checkout. */
      deliveryOptions: {
        id: string;
        name: string;
        kind: $Enums.DeliveryKind;
        description: string | null;
        baseFee: string;
      }[];
    }
> {
  const prisma = getPrismaClient();
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { name: true, subdomain: true, storefrontSettings: true },
  });
  if (store === null) {
    throw new AppError(404, "STORE_NOT_FOUND", "No store exists at that subdomain");
  }

  // The live campaign: active, inside its validity window (an
  // evergreen campaign — no window — always counts), newest first.
  // Only the banner copy is public; the linked coupon stays private.
  const liveCampaign = await prisma.campaign.findFirst({
    where: {
      storeId,
      isActive: true,
      OR: [
        { startsAt: null, endsAt: null },
        { startsAt: null, endsAt: { gt: now } },
        { startsAt: { lte: now }, endsAt: null },
        { startsAt: { lte: now }, endsAt: { gt: now } },
      ],
    },
    select: { bannerTitle: true, bannerSubtitle: true, ctaLabel: true },
    orderBy: { createdAt: "desc" },
  });

  // Capability flags: a method is "available" only if the store has the
  // backing configuration. paystack needs a provider credential; bank_transfer
  // needs a default merchant account with a real account number.
  const [credential, bankAccount, deliveryOptions] = await Promise.all([
    prisma.paymentCredential.findUnique({
      where: { storeId_provider: { storeId, provider: "paystack" } },
      select: { id: true },
    }),
    prisma.bankAccount.findFirst({
      where: { storeId, isDefault: true, accountNumber: { not: null } },
      select: { id: true },
    }),
    // The buyer's fulfilment choices (active, ordered). The fee is the
    // option's own baseFee; the server recomputes it at checkout.
    prisma.deliveryOption.findMany({
      where: { storeId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        kind: true,
        description: true,
        baseFee: true,
      },
    }),
  ]);
  const availablePaymentMethods: string[] = [];
  if (credential !== null) availablePaymentMethods.push("paystack");
  if (bankAccount !== null) availablePaymentMethods.push("bank_transfer");

  return {
    storeName: store.name,
    subdomain: store.subdomain ?? "",
    ...mergeStored(store.storefrontSettings),
    campaign: liveCampaign ?? null,
    availablePaymentMethods,
    deliveryOptions: deliveryOptions.map((option) => ({
      id: option.id,
      name: option.name,
      kind: option.kind,
      description: option.description,
      baseFee: option.baseFee.toFixed(2),
    })),
  };
}
