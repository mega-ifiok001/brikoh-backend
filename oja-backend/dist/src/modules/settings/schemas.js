import { z } from "zod";
import { onboardingBase } from "../auth/schemas.js";
export { validateOrThrow } from "../../lib/validate.js";
/**
 * ============================================================
 * DASHBOARD SETTINGS SCHEMAS
 * ============================================================
 * The business profile reuses the onboarding field rules verbatim —
 * business settings IS the profile collected at onboarding, edited
 * later. .strict() rejects stale/unknown fields.
 */
export const businessProfileSchema = z.object(onboardingBase).strict();
export const NOTIFICATION_TOGGLE_KEYS = [
    "lowStockAlerts",
    "paymentAlerts",
    "expiringSoonAlerts",
    "receiptsEnabled",
];
/** Partial update: every key optional, at least one required. */
export const notificationSettingsUpdateSchema = z
    .object({
    lowStockAlerts: z.boolean().optional(),
    paymentAlerts: z.boolean().optional(),
    expiringSoonAlerts: z.boolean().optional(),
    receiptsEnabled: z.boolean().optional(),
})
    .strict()
    .refine((data) => Object.keys(data).length > 0, {
    message: "at least one setting is required",
});
/**
 * Merchant-managed bank account for direct (manual) bank-transfer payments.
 * No provider involvement, so only the human-readable fields are needed;
 * accountNumber is validated as exactly 10 digits (Nigerian bank format).
 */
export const bankAccountCreateSchema = z
    .object({
    accountName: z
        .string()
        .trim()
        .min(1, "accountName is required")
        .max(200, "accountName too long"),
    bankName: z.string().trim().min(1, "bankName is required").max(200, "bankName too long"),
    accountNumber: z
        .string()
        .trim()
        .regex(/^\d{10}$/, "accountNumber must be exactly 10 digits"),
    isDefault: z.boolean().optional(),
})
    .strict();
/**
 * ============================================================
 * DELIVERY OPTIONS
 * ============================================================
 * The merchant's fulfilment choices at storefront checkout. A non-negative
 * money field normalizes to a "0.00" string (fees may legitimately be 0 for
 * pickup). Phase 1 is deliberately flat: the buyer's fee is the option's
 * `baseFee` plus the customer's own address — no zones or distance pricing.
 */
/** Fee / baseFee: number or decimal string, normalized to "0.00", >= 0. */
const feeSchema = z
    .union([
    z.number(),
    z.string().regex(/^\d+(?:\.\d{1,2})?$/, "must be a number with at most 2 decimal places"),
])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value >= 0, "must be 0 or greater")
    .refine((value) => value <= 99_999_999.99, "exceeds the maximum of 99999999.99")
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, "must have at most 2 decimal places")
    .transform((value) => value.toFixed(2));
const deliveryOptionNameSchema = z
    .string()
    .trim()
    .min(1, "name is required")
    .max(200, "name must be at most 200 characters");
export const deliveryOptionCreateSchema = z
    .object({
    name: deliveryOptionNameSchema,
    kind: z.enum(["PICKUP", "DELIVERY"], { error: "kind must be PICKUP or DELIVERY" }),
    description: z
        .string()
        .trim()
        .max(500, "description must be at most 500 characters")
        .nullable()
        .optional(),
    baseFee: feeSchema.optional(),
    isActive: z.boolean().optional(),
    sortOrder: z
        .number({ error: "sortOrder must be a number" })
        .int("sortOrder must be an integer")
        .min(0)
        .optional(),
    pickupLocationId: z.string().uuid("pickupLocationId must be a valid UUID").nullable().optional(),
    pickupAddressText: z
        .string()
        .trim()
        .max(500, "pickupAddressText must be at most 500 characters")
        .nullable()
        .optional(),
})
    .strict();
/** Partial update; supplied fields change, absent fields are unchanged. */
export const deliveryOptionUpdateSchema = deliveryOptionCreateSchema
    .partial()
    .refine((data) => Object.keys(data).length > 0, { message: "at least one field is required" });
//# sourceMappingURL=schemas.js.map