import { z } from "zod";
export { validateOrThrow } from "../../lib/validate.js";
/**
 * ============================================================
 * EXPENSES SCHEMAS
 * ============================================================
 * Operating expenses (dashboard-expenses.md). category is a fixed enum;
 * amount is a positive 2-dp money value; date is a UTC calendar day
 * ("YYYY-MM-DD"), the field the P&L report buckets by.
 */
/** Money value: number or decimal string, normalized to "0.00". */
const expenseAmountSchema = z
    .union([
    z.number(),
    z.string().regex(/^\d+(?:\.\d{1,2})?$/, "must be a number with at most 2 decimal places"),
])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value > 0, "amount must be greater than 0")
    .refine((value) => value <= 99_999_999.99, "exceeds the maximum of 99999999.99")
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, "must have at most 2 decimal places")
    .transform((value) => value.toFixed(2));
/** UTC calendar day "YYYY-MM-DD" (validates the date really exists). */
const expenseDateSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be a YYYY-MM-DD string")
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), "invalid calendar date");
export const EXPENSE_CATEGORIES = [
    "RENT",
    "TRANSPORT",
    "PACKAGING",
    "SALARIES",
    "MARKETING",
    "UTILITIES",
    "OTHER",
];
export const expenseCreateSchema = z
    .object({
    category: z.enum(EXPENSE_CATEGORIES),
    amount: expenseAmountSchema,
    description: z
        .string()
        .trim()
        .max(500, "description must be at most 500 characters")
        .optional(),
    date: expenseDateSchema,
})
    .strict();
export const expenseUpdateSchema = expenseCreateSchema
    .partial()
    .refine((data) => Object.keys(data).length > 0, "at least one field is required");
export const listExpensesParamsSchema = z
    .object({
    category: z.enum(EXPENSE_CATEGORIES).optional(),
    from: expenseDateSchema.optional(),
    to: expenseDateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(64).optional(),
})
    .strict()
    .refine((data) => data.from === undefined || data.to === undefined || data.from <= data.to, {
    message: "from must be on or before to",
    path: ["to"],
});
//# sourceMappingURL=schemas.js.map