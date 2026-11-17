import { z } from "zod";
import { AppError } from "../../lib/AppError.js";
import { DEFAULT_TOP, DAY_MS, GRANULARITIES, MAX_RANGE_DAYS, MAX_TOP, MIN_TOP, } from "./constants.js";
/**
 * Every analytics endpoint shares one query shape: a half-open UTC range,
 * an optional granularity, and an optional top-N. The range rules are
 * pinned here once (UTC-only offsets per RULES.md, start < end, max span)
 * so no endpoint can drift.
 */
const utcDateTime = z
    .string()
    .datetime({ offset: true })
    .refine((value) => /(Z|[+-]00:00)$/.test(value), "start and end must carry a UTC offset (Z or +00:00)");
export const analyticsQuerySchema = z
    .object({
    start: utcDateTime,
    end: utcDateTime,
    granularity: z.enum(GRANULARITIES).default("daily"),
    top: z.coerce.number().int().min(MIN_TOP).max(MAX_TOP).default(DEFAULT_TOP),
})
    .strict()
    .refine((d) => new Date(d.start).getTime() < new Date(d.end).getTime(), {
    message: "start must be before end",
    path: ["end"],
})
    .refine((d) => {
    const span = new Date(d.end).getTime() - new Date(d.start).getTime();
    return span <= MAX_RANGE_DAYS * DAY_MS;
}, {
    message: `range must be at most ${MAX_RANGE_DAYS} days`,
    path: ["end"],
});
/**
 * Validates the shared query and returns normalized Date boundaries.
 * Range-specific violations surface as `400 INVALID_RANGE` (deliberately
 * distinct from the generic VALIDATION_ERROR so dashboards can show
 * range-picker messages); the AppError carries the issues as internal
 * detail, never sent to clients.
 */
export function parseAnalyticsQuery(query) {
    const parsed = analyticsQuerySchema.safeParse(query);
    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; ");
        throw new AppError(400, "INVALID_RANGE", "Invalid analytics range", detail);
    }
    return {
        start: new Date(parsed.data.start),
        end: new Date(parsed.data.end),
        granularity: parsed.data.granularity,
        top: parsed.data.top,
    };
}
//# sourceMappingURL=schemas.js.map