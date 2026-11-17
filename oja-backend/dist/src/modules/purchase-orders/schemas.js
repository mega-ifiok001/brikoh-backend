import { z } from "zod";
export { validateOrThrow } from "../../lib/validate.js";
/**
 * ============================================================
 * PURCHASE ORDERS SCHEMAS
 * ============================================================
 * POs capture their own unit costs at order time (the merchant prices
 * an order independently of the catalog — same pattern as invoices).
 * Money fields normalize to "0.00" strings; receiving is per line item
 * and can never exceed the line's outstanding quantity.
 */
/** Order line unit cost: number or decimal string, normalized to "0.00". */
const purchaseUnitCostSchema = z
    .union([
    z.number(),
    z.string().regex(/^\d+(?:\.\d{1,2})?$/, "must be a number with at most 2 decimal places"),
])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value > 0, "must be greater than 0")
    .refine((value) => value <= 99_999_999.99, "exceeds the maximum of 99999999.99")
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, "must have at most 2 decimal places")
    .transform((value) => value.toFixed(2));
export const purchaseOrderLineItemSchema = z
    .object({
    productId: z.string().uuid("productId must be a valid UUID"),
    variantId: z.string().uuid("variantId must be a valid UUID").optional(),
    quantity: z
        .number({ error: "quantity must be a number" })
        .int("quantity must be an integer")
        .min(1, "quantity must be at least 1")
        .max(1_000_000, "quantity must be at most 1000000"),
    unitCostAtOrder: purchaseUnitCostSchema,
})
    .strict();
export const purchaseOrderLineItemsSchema = z
    .array(purchaseOrderLineItemSchema)
    .min(1, "lineItems must contain at least one item")
    .max(50, "lineItems must contain at most 50 items");
const purchaseOrderBaseSchema = z.object({
    supplierId: z.string().uuid("supplierId must be a valid UUID"),
    branchId: z.string().uuid("branchId must be a valid UUID"),
    expectedDeliveryDate: z.iso.datetime({ offset: true }).nullable().optional(),
    notes: z
        .string()
        .trim()
        .min(1, "notes must not be empty")
        .max(1000, "notes must be at most 1000 characters")
        .nullable()
        .optional(),
    lineItems: purchaseOrderLineItemsSchema,
});
export const createPurchaseOrderSchema = purchaseOrderBaseSchema.strict();
export const updatePurchaseOrderSchema = purchaseOrderBaseSchema.strict();
/** Receiving: per-line quantities, each within the line's remaining. */
export const receivePurchaseOrderSchema = z
    .object({
    note: z
        .string()
        .trim()
        .min(1, "note must not be empty")
        .max(1000, "note must be at most 1000 characters")
        .nullable()
        .optional(),
    lineItems: z
        .array(z
        .object({
        lineItemId: z.string().uuid("lineItemId must be a valid UUID"),
        quantityReceived: z
            .number({ error: "quantityReceived must be a number" })
            .int("quantityReceived must be an integer")
            .min(1, "quantityReceived must be at least 1")
            .max(1_000_000, "quantityReceived must be at most 1000000"),
    })
        .strict())
        .min(1, "lineItems must contain at least one item")
        .max(50, "lineItems must contain at most 50 items"),
})
    .strict();
/** Payment to the supplier: strictly positive, capped by balanceDue in the service. */
export const purchaseOrderPaymentSchema = z
    .object({
    amount: purchaseUnitCostSchema,
    note: z.string().trim().max(500, "note must be at most 500 characters").optional(),
})
    .strict();
/** GET /api/dashboard/purchase-orders query params (cursor-based pagination). */
export const listPurchaseOrdersParamsSchema = z.object({
    status: z.enum(["DRAFT", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"]).optional(),
    supplierId: z.string().uuid("supplierId must be a valid UUID").optional(),
    limit: z.coerce
        .number({ error: "limit must be a number" })
        .int("limit must be an integer")
        .min(1, "limit must be at least 1")
        .max(100, "limit must be at most 100")
        .default(20),
    cursor: z.string().uuid("cursor must be a valid UUID").optional(),
});
//# sourceMappingURL=schemas.js.map