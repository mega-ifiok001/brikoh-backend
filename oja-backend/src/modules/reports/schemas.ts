import { z } from "zod";
import { AppError } from "../../lib/AppError.js";

export { validateOrThrow } from "../../lib/validate.js";

/**
 * ============================================================
 * REPORTS SCHEMAS
 * ============================================================
 * Reports accept either a calendar date (`date=YYYY-MM-DD`) or an inclusive
 * calendar range (`startDate` + `endDate`). Calendar dates are UTC dates; the
 * end date is expanded to the next midnight so filtering remains [start, end).
 * The former `start` + `end` UTC timestamp contract remains supported.
 * ============================================================
 */

const utcDateSchema = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid date and time.")
  .refine(
    (value) => /(Z|[+-]00:00)$/.test(value),
    "Dates must be in UTC (include a 'Z' or '+00:00' offset).",
  );

const reportRangeSchema = z.object({ start: utcDateSchema, end: utcDateSchema });

export interface ParsedReportRange {
  start: Date;
  end: Date;
  /** Inclusive YYYY-MM-DD boundaries when the calendar-date API is used. */
  dates?: { startDate: string; endDate: string };
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
 * Validates `?start=&end=` and returns normalized Date boundaries. Missing
 * dates, malformed/non-UTC dates, and a reversed range all throw
 * `400 INVALID_RANGE` with a clear message.
 */
export function parseReportRange(query: unknown): ParsedReportRange {
  const raw = (typeof query === "object" && query !== null ? query : {}) as Record<string, unknown>;
  const hasDate = "date" in raw;
  const hasStartDate = "startDate" in raw;
  const hasEndDate = "endDate" in raw;
  const hasCalendarParams = hasDate || hasStartDate || hasEndDate;
  const hasTimestampParams = "start" in raw || "end" in raw;
  const date = typeof raw.date === "string" ? raw.date.trim() : "";
  const startDate = typeof raw.startDate === "string" ? raw.startDate.trim() : "";
  const endDate = typeof raw.endDate === "string" ? raw.endDate.trim() : "";

  if (hasCalendarParams) {
    if (hasTimestampParams) {
      throw new AppError(400, "INVALID_RANGE", "Use calendar dates or timestamps, not both.");
    }
    if (hasDate && (hasStartDate || hasEndDate)) {
      throw new AppError(
        400,
        "INVALID_RANGE",
        "Provide either one date or a start date and end date, not both.",
      );
    }
    const startRaw = hasDate ? date : startDate;
    const endRaw = hasDate ? date : endDate;
    if (startRaw === "" || endRaw === "") {
      throw new AppError(400, "INVALID_RANGE", "Please provide both a start date and end date.");
    }
    const parsedDates = z
      .object({ startDate: calendarDateSchema, endDate: calendarDateSchema })
      .safeParse({ startDate: startRaw, endDate: endRaw });
    if (!parsedDates.success) {
      const message = parsedDates.error.issues[0]?.message ?? "Enter a valid date range.";
      throw new AppError(400, "INVALID_RANGE", message);
    }
    if (parsedDates.data.startDate > parsedDates.data.endDate) {
      throw new AppError(400, "INVALID_RANGE", "The start date must be on or before the end date.");
    }
    const exclusiveEnd = utcMidnight(parsedDates.data.endDate);
    exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
    return {
      start: utcMidnight(parsedDates.data.startDate),
      end: exclusiveEnd,
      dates: parsedDates.data,
    };
  }

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
