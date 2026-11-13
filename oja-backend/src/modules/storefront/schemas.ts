import { z } from "zod";
import { phoneSchema } from "../../lib/validation.js";

export { validateOrThrow } from "../../lib/validate.js";

/**
 * ============================================================
 * STOREFRONT SETTINGS SCHEMAS
 * ============================================================
 * What the public storefront renders, owned by the Website Studio.
 * Stored as JSON on Store.storefrontSettings; this schema is the single
 * authority on shape and rules. The accent color is deliberately a
 * fixed curated swatch — the storefront palette is a brand choice, not
 * a free-form color.
 */

export const STOREFRONT_TEMPLATES = ["CLASSIC", "MODERN", "BOLD"] as const;
export type StorefrontTemplate = (typeof STOREFRONT_TEMPLATES)[number];

/** The fixed swatch the accent-color picker draws from. */
export const ACCENT_SWATCH = [
  "#18181b",
  "#16a34a",
  "#2563eb",
  "#ea580c",
  "#db2777",
  "#7c3aed",
  "#0d9488",
  "#dc2626",
] as const;
export type AccentColor = (typeof ACCENT_SWATCH)[number];

const nullableUrl = z.union([
  z
    .string()
    .trim()
    .url("must be a valid URL")
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
      message: "must be an http(s) URL",
    }),
  z.null(),
]);

export const socialLinksSchema = z
  .object({
    instagram: nullableUrl.optional(),
    facebook: nullableUrl.optional(),
    tiktok: nullableUrl.optional(),
  })
  .strict();

export type SocialLinks = z.infer<typeof socialLinksSchema>;

/**
 * Google Analytics 4 measurement ID — `G-` followed by 6-12 uppercase
 * letters/digits (e.g. `G-ABCDE12345`). Null = no gtag injected on the
 * storefront.
 */
export const ga4MeasurementIdSchema = z
  .string()
  .regex(/^G-[A-Z0-9]{6,12}$/, "must look like a GA4 measurement ID (G-XXXXXX…)")
  .nullable();
export type Ga4MeasurementId = z.infer<typeof ga4MeasurementIdSchema>;

/** The complete storefront setting set (defaults merged). */
export const storefrontSettingsSchema = z
  .object({
    template: z.enum(STOREFRONT_TEMPLATES),
    tagline: z.string().trim().min(1).max(80).nullable(),
    heroTitle: z.string().trim().min(1).max(60).nullable(),
    heroSubtitle: z.string().trim().min(1).max(120).nullable(),
    accentColor: z.enum(ACCENT_SWATCH),
    whatsappButtonEnabled: z.boolean(),
    whatsappNumber: phoneSchema.nullable(),
    showPoweredByBadge: z.boolean(),
    ga4MeasurementId: ga4MeasurementIdSchema,
    socialLinks: socialLinksSchema,
  })
  .strict();
export type StorefrontSettings = z.infer<typeof storefrontSettingsSchema>;

/** Partial update: every key optional, at least one required. */
export const storefrontSettingsUpdateSchema = z
  .object({
    template: z.enum(STOREFRONT_TEMPLATES).optional(),
    tagline: z.string().trim().min(1).max(80).nullable().optional(),
    heroTitle: z.string().trim().min(1).max(60).nullable().optional(),
    heroSubtitle: z.string().trim().min(1).max(120).nullable().optional(),
    accentColor: z.enum(ACCENT_SWATCH).optional(),
    whatsappButtonEnabled: z.boolean().optional(),
    whatsappNumber: phoneSchema.nullable().optional(),
    showPoweredByBadge: z.boolean().optional(),
    ga4MeasurementId: ga4MeasurementIdSchema.optional(),
    socialLinks: socialLinksSchema.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "at least one setting is required",
  });
export type StorefrontSettingsUpdateInput = z.infer<typeof storefrontSettingsUpdateSchema>;

/** Defaults for unset values (mirrors the notification-settings rule). */
export const DEFAULT_STOREFRONT_SETTINGS: StorefrontSettings = {
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
};
