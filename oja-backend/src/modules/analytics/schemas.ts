import { z } from "zod";
import { AppError } from "../../lib/AppError.js";
import { DEFAULT_TOP, DAY_MS, MAX_TOP, MIN_TOP, type Granularity } from "./constants.js";

/**
 * Every analytics endpoint takes one UTC calendar date. Internally that
 * date becomes a half-open midnight-to-midnight range. Analytics is daily;
 * it no longer accepts a start/end interval or weekly aggregation.
 */

const utcDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must use YYYY-MM-DD format")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "date must be a valid calendar date");

export const analyticsQuerySchema = z
  .object({
    date: utcDate,
    granularity: z.literal("daily").default("daily"),
    top: z.coerce.number().int().min(MIN_TOP).max(MAX_TOP).default(DEFAULT_TOP),
  })
  .strict();

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export interface ParsedAnalyticsRange {
  date: string;
  start: Date;
  end: Date;
  granularity: Granularity;
  top: number;
}

/**
 * Validates the selected day and returns its UTC midnight boundaries.
 * Invalid dates surface as `400 INVALID_RANGE`.
 */
export function parseAnalyticsQuery(query: unknown): ParsedAnalyticsRange {
  const parsed = analyticsQuerySchema.safeParse(query);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new AppError(400, "INVALID_RANGE", "Invalid analytics range", detail);
  }
  const start = new Date(`${parsed.data.date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + DAY_MS);
  return {
    date: parsed.data.date,
    start,
    end,
    granularity: parsed.data.granularity,
    top: parsed.data.top,
  };
}
