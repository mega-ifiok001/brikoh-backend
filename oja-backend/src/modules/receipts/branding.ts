import type { $Enums } from "../../../generated/prisma/client.js";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/AppError.js";
import { deriveApex } from "../../lib/cors.js";
import { getPrismaClient } from "../../lib/prisma.js";

/**
 * ============================================================
 * MERCHANT BRANDING — what makes a receipt look like the store's
 * ============================================================
 * Resolves the merchant's own identity for customer-facing emails:
 * store name, logo, accent color, address, phone, currency, storefront
 * link, and social links. Accent precedence is template settings (an
 * arbitrary hex) then storefront settings (the curated swatch) then the
 * neutral default. Free text is escaped by the email builder, not here.
 */

export interface MerchantSocialLinks {
  instagram: string | null;
  facebook: string | null;
  tiktok: string | null;
}

export interface MerchantBranding {
  storeName: string;
  logoUrl: string | null;
  accentColor: string;
  address: string;
  phone: string;
  currency: $Enums.Currency;
  storefrontUrl: string;
  socialLinks: MerchantSocialLinks;
  /** The owner's email — the receipt's reply-to, or null when unknown. */
  replyTo: string | null;
}

const DEFAULT_ACCENT = "#18181b";
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function pickAccent(templateSettings: unknown, storefrontSettings: unknown): string {
  const templateAccent = asRecord(templateSettings).accentColor;
  if (typeof templateAccent === "string" && HEX_COLOR_RE.test(templateAccent)) {
    return templateAccent;
  }
  const storefrontAccent = asRecord(storefrontSettings).accentColor;
  if (typeof storefrontAccent === "string" && HEX_COLOR_RE.test(storefrontAccent)) {
    return storefrontAccent;
  }
  return DEFAULT_ACCENT;
}

function pickLogo(templateSettings: unknown): string | null {
  const logo = asRecord(templateSettings).logoUrl;
  return typeof logo === "string" && logo.length > 0 ? logo : null;
}

function pickSocialLinks(storefrontSettings: unknown): MerchantSocialLinks {
  const raw = asRecord(asRecord(storefrontSettings).socialLinks);
  return {
    instagram: typeof raw.instagram === "string" ? raw.instagram : null,
    facebook: typeof raw.facebook === "string" ? raw.facebook : null,
    tiktok: typeof raw.tiktok === "string" ? raw.tiktok : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** The public storefront URL: the custom domain, else subdomain + apex. */
function storefrontUrlFor(customDomain: string | null, subdomain: string | null): string {
  if (customDomain !== null && customDomain.length > 0) {
    return `https://${customDomain}`;
  }
  if (subdomain !== null && subdomain.length > 0) {
    let apex = "brikoh.com";
    try {
      apex = deriveApex(new URL(env.FRONTEND_URL).hostname);
    } catch {
      // fall back to the default apex
    }
    return `https://${subdomain}.${apex}`;
  }
  return env.FRONTEND_URL.replace(/\/+$/, "");
}

export async function loadMerchantBranding(storeId: string): Promise<MerchantBranding> {
  const store = await getPrismaClient().store.findUnique({
    where: { id: storeId },
    select: {
      name: true,
      businessPhone: true,
      location: true,
      currency: true,
      customDomain: true,
      subdomain: true,
      storefrontSettings: true,
      templateSettings: true,
      owner: { select: { account: { select: { email: true } } } },
    },
  });
  if (store === null) {
    throw new AppError(404, "NOT_FOUND", "Store not found");
  }

  return {
    storeName: store.name,
    logoUrl: pickLogo(store.templateSettings),
    accentColor: pickAccent(store.templateSettings, store.storefrontSettings),
    address: store.location,
    phone: store.businessPhone,
    currency: store.currency,
    storefrontUrl: storefrontUrlFor(store.customDomain, store.subdomain),
    socialLinks: pickSocialLinks(store.storefrontSettings),
    replyTo: store.owner?.account.email ?? null,
  };
}
