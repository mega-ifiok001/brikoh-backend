import { z } from "zod";

export { validateOrThrow } from "../../lib/validate.js";

/**
 * ============================================================
 * CAMPAIGNS SCHEMAS
 * ============================================================
 * Time-boxed storefront promotions (dashboard-campaigns.md): banner copy
 * (1-80 chars each), an optional validity window (endsAt must be after
 * startsAt when both are set), and an optional link to a coupon of the
 * same store (validated at the service layer against the tenant).
 * ============================================================
 */

const isoDatetimeSchema = z.iso.datetime({ offset: true });

const bannerCopySchema = z
  .string()
  .trim()
  .min(1, "banner copy must be at least 1 character")
  .max(80, "banner copy must be at most 80 characters");

export const campaignCreateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "name is required")
      .max(100, "name must be at most 100 characters"),
    startsAt: isoDatetimeSchema.nullable().optional(),
    endsAt: isoDatetimeSchema.nullable().optional(),
    bannerTitle: bannerCopySchema.nullable().optional(),
    bannerSubtitle: bannerCopySchema.nullable().optional(),
    ctaLabel: bannerCopySchema.nullable().optional(),
    discountId: z.string().uuid("discountId must be a valid UUID").nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.startsAt !== undefined &&
      data.startsAt !== null &&
      data.endsAt !== undefined &&
      data.endsAt !== null &&
      new Date(data.endsAt) <= new Date(data.startsAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endsAt must be later than startsAt",
        path: ["endsAt"],
      });
    }
  });
export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;

export const campaignUpdateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "name is required")
      .max(100, "name must be at most 100 characters")
      .optional(),
    startsAt: isoDatetimeSchema.nullable().optional(),
    endsAt: isoDatetimeSchema.nullable().optional(),
    bannerTitle: bannerCopySchema.nullable().optional(),
    bannerSubtitle: bannerCopySchema.nullable().optional(),
    ctaLabel: bannerCopySchema.nullable().optional(),
    discountId: z.string().uuid("discountId must be a valid UUID").nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "at least one field is required",
  })
  .superRefine((data, ctx) => {
    if (
      data.startsAt !== undefined &&
      data.startsAt !== null &&
      data.endsAt !== undefined &&
      data.endsAt !== null &&
      new Date(data.endsAt) <= new Date(data.startsAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endsAt must be later than startsAt",
        path: ["endsAt"],
      });
    }
  });
export type CampaignUpdateInput = z.infer<typeof campaignUpdateSchema>;

/** GET /api/dashboard/campaigns query params (cursor-based pagination). */
export const listCampaignsParamsSchema = z.object({
  isActive: z
    .enum(["true", "false"], { error: "isActive must be true or false" })
    .transform((value) => value === "true")
    .optional(),
  limit: z.coerce
    .number({ error: "limit must be a number" })
    .int("limit must be an integer")
    .min(1, "limit must be at least 1")
    .max(100, "limit must be at most 100")
    .default(50),
  cursor: z.string().uuid("cursor must be a valid UUID").optional(),
});
export type ListCampaignsParams = z.infer<typeof listCampaignsParamsSchema>;
