import { z } from "zod";
import { AppError } from "../../lib/AppError.js";

export { validateOrThrow } from "../../lib/validate.js";

/**
 * ============================================================
 * REPORTS SCHEMAS
 * ============================================================
 * Reports take one calendar date (`date=YYYY-MM-DD`). It is interpreted in
 * UTC and expanded to that day's half-open midnight-to-midnight interval.
 * ============================================================
 */

export interface ParsedReportRange {
  date: string;
  start: Date;
  end: Date;
}

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date in YYYY-MM-DD format.")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Enter a valid calendar date.");

function utcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/**
 * Validates `?date=YYYY-MM-DD` and returns the selected day's UTC boundaries.
 */
export function parseReportRange(query: unknown): ParsedReportRange {
  const raw = (typeof query === "object" && query !== null ? query : {}) as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "date")) {
    throw new AppError(400, "INVALID_RANGE", "Only the date query parameter is supported.");
  }
  const date = typeof raw.date === "string" ? raw.date.trim() : "";
  if (date === "") {
    throw new AppError(400, "INVALID_RANGE", "Please provide a date in YYYY-MM-DD format.");
  }

  const parsed = calendarDateSchema.safeParse(date);
  if (!parsed.success) {
    throw new AppError(
      400,
      "INVALID_RANGE",
      parsed.error.issues[0]?.message ?? "Enter a valid date.",
    );
  }
  const start = utcMidnight(parsed.data);
  const end = new Date(start.getTime() + 86_400_000);
  return { date: parsed.data, start, end };
}
