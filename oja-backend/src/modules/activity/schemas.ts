import { z } from "zod";

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must use YYYY-MM-DD format")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "date must be a valid calendar date");

export const listStoreActivityParamsSchema = z.object({
  limit: z.coerce
    .number({ error: "limit must be a number" })
    .int("limit must be an integer")
    .min(1, "limit must be at least 1")
    .max(200, "limit must be at most 200")
    .default(50),
  cursor: z.string().trim().min(1, "cursor must be an activity entry id").optional(),
  staffMemberId: z.string().trim().min(1, "Staff member ID is invalid").optional(),
  date: calendarDate.optional(),
});
export type ListStoreActivityParams = z.infer<typeof listStoreActivityParamsSchema>;
