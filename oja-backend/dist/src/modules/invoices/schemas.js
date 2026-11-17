import { z } from "zod";
/**
 * ============================================================
 * INVOICES SCHEMAS — draft/issue lifecycle + payment ledger
 * ============================================================
 * Invoices capture their own line prices at issue time (unlike POS
 * sales, prices ARE client-supplied here — the merchant prices an
 * invoice independently of the catalog). Money fields normalize to
 * "0.00" strings; payment amounts are strictly positive like credit
 * repayments.
 */
/** Invoice line price: number or decimal string, normalized to "0.00". */
const invoiceUnitPriceSchema = z
    .union([
    z.number(),
    z.string().regex(/^\d+(?:\.\d{1,2})?$/, "must be a number with at most 2 decimal places"),
])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value > 0, "must be greater than 0")
    .refine((value) => value <= 99_999_999.99, "exceeds the maximum of 99999999.99")
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, "must have at most 2 decimal places")
    .transform((value) => value.toFixed(2));
export const invoiceLineItemSchema = z.object({
    productId: z.string().uuid("productId must be a valid UUID"),
    quantity: z
        .number({ error: "quantity must be a number" })
        .int("quantity must be an integer")
        .min(1, "quantity must be at least 1")
        .max(1_000_000, "quantity must be at most 1000000"),
    unitPriceAtIssue: invoiceUnitPriceSchema,
});
export const invoiceLineItemsSchema = z
    .array(invoiceLineItemSchema)
    .min(1, "lineItems must contain at least one item")
    .max(50, "lineItems must contain at most 50 items");
export const invoiceCreateSchema = z
    .object({
    customerId: z.string().uuid("customerId must be a valid UUID"),
    dueDate: z.iso.datetime({ offset: true }).optional(),
    lineItems: invoiceLineItemsSchema,
})
    .strict();
export const invoiceUpdateSchema = z
    .object({
    dueDate: z.iso.datetime({ offset: true }).nullable().optional(),
    lineItems: invoiceLineItemsSchema,
})
    .strict();
/** Payment money field: number or decimal string, normalized to "0.00". */
const invoicePaymentAmountSchema = z
    .union([
    z.number(),
    z.string().regex(/^\d+(?:\.\d{1,2})?$/, "must be a number with at most 2 decimal places"),
])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value > 0, "amount must be greater than 0")
    .refine((value) => value <= 99_999_999.99, "exceeds the maximum of 99999999.99")
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, "must have at most 2 decimal places")
    .transform((value) => value.toFixed(2));
export const invoicePaymentSchema = z
    .object({
    amount: invoicePaymentAmountSchema,
    note: z.string().trim().max(500, "note must be at most 500 characters").optional(),
})
    .strict();
/** GET /api/dashboard/invoices query params (cursor-based pagination). */
export const listInvoicesParamsSchema = z.object({
    status: z.enum(["DRAFT", "ISSUED", "PAID", "VOID"]).optional(),
    q: z
        .string()
        .trim()
        .min(1, "q must not be empty")
        .max(200, "q must be at most 200 characters")
        .optional(),
    customerId: z.string().uuid("customerId must be a valid UUID").optional(),
    limit: z.coerce
        .number({ error: "limit must be a number" })
        .int("limit must be an integer")
        .min(1, "limit must be at least 1")
        .max(100, "limit must be at most 100")
        .default(20),
    cursor: z.string().uuid("cursor must be a valid UUID").optional(),
});
//# sourceMappingURL=schemas.js.map