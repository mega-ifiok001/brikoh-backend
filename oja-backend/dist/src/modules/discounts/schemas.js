import { z } from "zod";
export { validateOrThrow } from "../../lib/validate.js";
/**
 * ============================================================
 * DISCOUNTS SCHEMAS
 * ============================================================
 * Reusable cart-wide discounts. type is PERCENTAGE or FIXED; value is a
 * positive 2-dp money/percent number bounded per type (percent <= 100).
 * code is optional, unique per store (case-insensitive), normalized to
 * uppercase server-side. startsAt/endsAt bound an optional validity
 * window (endsAt must be after startsAt when both are set).
 */
/** Money/percent value: number or decimal string, normalized to "0.00". */
const discountValueSchema = z
    .union([
    z.number(),
    z.string().regex(/^\d+(?:\.\d{1,2})?$/, "must be a number with at most 2 decimal places"),
])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value > 0, "value must be greater than 0")
    .refine((value) => value <= 99_999_999.99, "exceeds the maximum of 99999999.99")
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, "must have at most 2 decimal places")
    .transform((value) => value.toFixed(2));
const discountCodeSchema = z
    .string()
    .trim()
    .min(3, "code must be at least 3 characters")
    .max(40, "code must be at most 40 characters")
    .regex(/^[A-Za-z0-9-]+$/, "code may only contain letters, digits, and dashes")
    .transform((value) => value.toUpperCase());
const isoDatetimeSchema = z.iso.datetime({ offset: true });
export const discountCreateSchema = z
    .object({
    name: z
        .string()
        .trim()
        .min(1, "name is required")
        .max(100, "name must be at most 100 characters"),
    type: z.enum(["PERCENTAGE", "FIXED"]),
    value: discountValueSchema,
    code: discountCodeSchema.optional(),
    startsAt: isoDatetimeSchema.nullable().optional(),
    endsAt: isoDatetimeSchema.nullable().optional(),
    isActive: z.boolean().optional(),
})
    .strict()
    .superRefine((data, ctx) => {
    if (data.type === "PERCENTAGE" && Number(data.value) > 100) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "a PERCENTAGE discount must be at most 100",
            path: ["value"],
        });
    }
    if (data.startsAt !== undefined &&
        data.startsAt !== null &&
        data.endsAt !== undefined &&
        data.endsAt !== null &&
        new Date(data.endsAt) <= new Date(data.startsAt)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "endsAt must be later than startsAt",
            path: ["endsAt"],
        });
    }
});
export const discountUpdateSchema = z
    .object({
    name: z
        .string()
        .trim()
        .min(1, "name is required")
        .max(100, "name must be at most 100 characters")
        .optional(),
    type: z.enum(["PERCENTAGE", "FIXED"]).optional(),
    value: discountValueSchema.optional(),
    code: discountCodeSchema.nullable().optional(),
    startsAt: isoDatetimeSchema.nullable().optional(),
    endsAt: isoDatetimeSchema.nullable().optional(),
    isActive: z.boolean().optional(),
})
    .strict()
    .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "at least one field is required",
})
    .superRefine((data, ctx) => {
    const effectiveType = data.type ?? "PERCENTAGE";
    const effectiveValue = data.value ?? "0";
    if (effectiveType === "PERCENTAGE" && Number(effectiveValue) > 100) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "a PERCENTAGE discount must be at most 100",
            path: ["value"],
        });
    }
    if (data.startsAt !== undefined &&
        data.startsAt !== null &&
        data.endsAt !== undefined &&
        data.endsAt !== null &&
        new Date(data.endsAt) <= new Date(data.startsAt)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "endsAt must be later than startsAt",
            path: ["endsAt"],
        });
    }
});
/** GET /api/dashboard/discounts query params (cursor-based pagination). */
export const listDiscountsParamsSchema = z.object({
    isActive: z
        .enum(["true", "false"], { error: "isActive must be true or false" })
        .transform((value) => value === "true")
        .optional(),
    type: z.enum(["PERCENTAGE", "FIXED"]).optional(),
    limit: z.coerce
        .number({ error: "limit must be a number" })
        .int("limit must be an integer")
        .min(1, "limit must be at least 1")
        .max(100, "limit must be at most 100")
        .default(50),
    cursor: z.string().uuid("cursor must be a valid UUID").optional(),
});
//# sourceMappingURL=schemas.js.map