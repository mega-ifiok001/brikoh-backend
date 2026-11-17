import { z } from "zod";
import { AppError } from "../../lib/AppError.js";
export { validateOrThrow } from "../../lib/validate.js";
/**
 * ============================================================
 * REPORTS SCHEMAS
 * ============================================================
 * Reports take an explicit half-open UTC range [start, end) — no presets.
 * Both dates are required and must carry a UTC offset; start < end. Range
 * violations surface as `400 INVALID_RANGE` with a plain-language message
 * (the UI's date picker shows it verbatim). There is no default range and
 * no maximum span — the range is bounded only by start < end.
 * ============================================================
 */
const utcDateSchema = z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid date and time.")
    .refine((value) => /(Z|[+-]00:00)$/.test(value), "Dates must be in UTC (include a 'Z' or '+00:00' offset).");
const reportRangeSchema = z.object({ start: utcDateSchema, end: utcDateSchema });
/**
 * Validates `?start=&end=` and returns normalized Date boundaries. Missing
 * dates, malformed/non-UTC dates, and a reversed range all throw
 * `400 INVALID_RANGE` with a clear message.
 */
export function parseReportRange(query) {
    const raw = (typeof query === "object" && query !== null ? query : {});
    const startRaw = typeof raw.start === "string" ? raw.start.trim() : "";
    const endRaw = typeof raw.end === "string" ? raw.end.trim() : "";
    if (startRaw === "" || endRaw === "") {
        throw new AppError(400, "INVALID_RANGE", "Please provide both a start and end date.");
    }
    const parsed = reportRangeSchema.safeParse({ start: startRaw, end: endRaw });
    if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? "Enter a valid date range.";
        const detail = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; ");
        throw new AppError(400, "INVALID_RANGE", message, detail);
    }
    const start = new Date(parsed.data.start);
    const end = new Date(parsed.data.end);
    if (start.getTime() >= end.getTime()) {
        throw new AppError(400, "INVALID_RANGE", "The start date must be before the end date.");
    }
    return { start, end };
}
//# sourceMappingURL=schemas.js.map