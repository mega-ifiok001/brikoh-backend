import { z } from "zod";
import { emailSchema } from "../auth/schemas.js";
import { phoneSchema } from "../../lib/validation.js";

export { validateOrThrow } from "../../lib/validate.js";

/**
 * ============================================================
 * CUSTOMERS SCHEMAS — address book + credit repayments
 * ============================================================
 * Mirrors the POS/checkout customer shapes: name is required, phone and
 * email optional. Email is lowercased by emailSchema. Updates accept
 * explicit null to clear phone/email.
 */

export const customerNameSchema = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(200, "name must be at most 200 characters");

const groupIdSchema = z.string().uuid("groupId must be a valid UUID");

export const customerCreateSchema = z
  .object({
    name: customerNameSchema,
    phone: phoneSchema.nullable().optional(),
    email: emailSchema.nullable().optional(),
    // Optional segment; omitted customers land in the store's default
    // "General" group (dashboard-customer-groups.md).
    groupId: groupIdSchema.nullable().optional(),
  })
  .strict();
export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;

export const customerUpdateSchema = z
  .object({
    name: customerNameSchema.optional(),
    phone: phoneSchema.nullable().optional(),
    email: emailSchema.nullable().optional(),
    groupId: groupIdSchema.nullable().optional(),
  })
  .strict()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "at least one field is required",
  });
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;

/** Repayment money field: number or decimal string, normalized to "0.00". */
const repaymentAmountSchema = z
  .union([
    z.number(),
    z.string().regex(/^\d+(?:\.\d{1,2})?$/, "must be a number with at most 2 decimal places"),
  ])
  .transform((value) => Number(value))
  .refine((value) => Number.isFinite(value) && value > 0, "amount must be greater than 0")
  .refine((value) => value <= 99_999_999.99, "exceeds the maximum of 99999999.99")
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
    "must have at most 2 decimal places",
  )
  .transform((value) => value.toFixed(2));

export const creditRepaymentSchema = z
  .object({
    amount: repaymentAmountSchema,
    note: z.string().trim().max(500, "note must be at most 500 characters").optional(),
  })
  .strict();
export type CreditRepaymentInput = z.infer<typeof creditRepaymentSchema>;

/** GET /api/dashboard/customers query params (cursor-based pagination). */
export const listCustomersParamsSchema = z.object({
  q: z
    .string()
    .trim()
    .min(1, "Search text can't be empty")
    .max(200, "q must be at most 200 characters")
    .optional(),
  hasOutstandingCredit: z
    .enum(["true", "false"], { error: "hasOutstandingCredit must be true or false" })
    .transform((value) => value === "true")
    .optional(),
  limit: z.coerce
    .number({ error: "limit must be a number" })
    .int("limit must be an integer")
    .min(1, "limit must be at least 1")
    .max(100, "limit must be at most 100")
    .default(20),
  cursor: z.string().uuid("cursor must be a valid UUID").optional(),
});
export type ListCustomersParams = z.infer<typeof listCustomersParamsSchema>;
