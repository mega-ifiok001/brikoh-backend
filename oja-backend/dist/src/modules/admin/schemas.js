import { z } from "zod";
import { AppError } from "../../lib/AppError.js";
import { GRANULARITIES, MAX_RANGE_DAYS, DAY_MS } from "../analytics/constants.js";
/**
 * Every admin endpoint's request validation. Range rules mirror the
 * analytics contract (UTC-only offsets, half-open, max span) so the two
 * sides of the platform never drift.
 */
const utcDateTime = z
    .string()
    .datetime({ offset: true })
    .refine((value) => /(Z|[+-]00:00)$/.test(value), "must carry a UTC offset (Z or +00:00)");
const uuid = z.uuid("must be a valid uuid");
/** login: the TOTP token is mandatory — there is no admin session without it. */
export const adminLoginSchema = z
    .object({
    email: z.email("must be a valid email"),
    password: z.string().min(8, "password must be at least 8 characters"),
    totpToken: z.string().regex(/^\d{6}$/, "totpToken must be 6 digits"),
})
    .strict();
/** Break-glass 2FA reset: the target admin's id (a SUPER_ADMIN performs it). */
export const adminResetSchema = z
    .object({
    adminUserId: z.uuid("adminUserId must be a valid uuid"),
})
    .strict();
/** Refresh / logout: the opaque admin refresh token returned at login. */
export const adminRefreshSchema = z
    .object({
    refreshToken: z.string().min(1, "refreshToken is required"),
})
    .strict();
function refineRange(range) {
    if (range.start === undefined || range.end === undefined)
        return true;
    return new Date(range.start).getTime() < new Date(range.end).getTime();
}
export const auditQuerySchema = z
    .object({
    adminId: uuid.optional(),
    storeId: uuid.optional(),
    action: z.string().min(1).max(100).optional(),
    start: utcDateTime.optional(),
    end: utcDateTime.optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
})
    .strict()
    .refine(refineRange, { message: "start must be before end", path: ["end"] });
export const searchStoresSchema = z
    .object({
    q: z.string().trim().min(1).max(200).optional(),
    tier: z.enum(["starter", "pro", "enterprise"]).optional(),
    subscriptionStatus: z.enum(["active", "inactive"]).optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
})
    .strict();
const metricRangeSchema = z
    .object({
    start: utcDateTime,
    end: utcDateTime,
})
    .refine((d) => new Date(d.start).getTime() < new Date(d.end).getTime(), {
    message: "start must be before end",
    path: ["end"],
})
    .refine((d) => new Date(d.end).getTime() - new Date(d.start).getTime() <= MAX_RANGE_DAYS * DAY_MS, { message: `range must be at most ${MAX_RANGE_DAYS} days`, path: ["end"] });
export const signupsQuerySchema = metricRangeSchema.extend({
    granularity: z.enum(GRANULARITIES).default("daily"),
});
export const churnQuerySchema = metricRangeSchema;
export const activationQuerySchema = metricRangeSchema;
export const pricingUpdateSchema = z
    .object({
    monthlyPrice: z
        .number()
        .int()
        .positive()
        .max(1_000_000_000)
        .nullable()
        .describe("monthly price in minor units, or null to mark the plan free/excluded"),
    // The Paystack plan (PLN_...) created on the platform account for this
    // tier. Optional here; when provided it is stored alongside the price.
    paystackPlanCode: z
        .string()
        .trim()
        .min(1, "paystackPlanCode must not be empty")
        .max(128, "paystackPlanCode must be at most 128 characters")
        .regex(/^PLN_[A-Za-z0-9]+$/, "paystackPlanCode must look like PLN_...")
        .nullable()
        .optional(),
})
    .strict();
export const orphanedOrdersQuerySchema = z.object({
    hours: z.coerce.number().int().min(1).max(720).default(24),
});
export const merchantsQuerySchema = z
    .object({
    q: z.string().trim().min(1).max(200).optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
})
    .strict();
export const storesViewQuerySchema = z
    .object({
    q: z.string().trim().min(1).max(200).optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
})
    .strict();
export const ordersViewQuerySchema = z
    .object({
    status: z
        .enum(["PENDING", "AWAITING_PAYMENT", "PAID", "SHIPPED", "CANCELLED", "REFUNDED", "FAILED"])
        .optional(),
    q: z.string().trim().min(1).max(200).optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
})
    .strict();
/**
 * Parses a metric/range query, normalizing UTC strings to Dates. All
 * violations surface as 400 INVALID_RANGE (mirroring analytics), carrying
 * issue detail as internal-only AppError detail.
 */
export function parseMetricRange(query) {
    const parsed = metricRangeSchema.safeParse(query);
    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; ");
        throw new AppError(400, "INVALID_RANGE", "Invalid date range", detail);
    }
    return { start: new Date(parsed.data.start), end: new Date(parsed.data.end) };
}
//# sourceMappingURL=schemas.js.map