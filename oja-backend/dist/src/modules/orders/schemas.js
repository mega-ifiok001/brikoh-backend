import { z } from "zod";
import { emailSchema } from "../auth/schemas.js";
import { validateOrThrow } from "../../lib/validate.js";
export { validateOrThrow };
/**
 * Public checkout payload. Prices are NEVER client-supplied: the cart
 * carries product ids (and optional variant ids) and quantities only;
 * unit prices and the total are read from the database at checkout time
 * (unitPriceAtPurchase). variantId is REQUIRED by the service when the
 * product has variants — the service rejects a bare productId then.
 */
export const checkoutItemSchema = z.object({
    productId: z.string().min(1, "productId is required"),
    variantId: z.string().min(1, "Variant ID can't be empty").optional(),
    quantity: z
        .number({ error: "quantity must be a number" })
        .int("quantity must be an integer")
        .min(1, "quantity must be at least 1")
        .max(9999, "quantity must be at most 9999"),
});
export const checkoutCustomerSchema = z.object({
    name: z
        .string()
        .trim()
        .min(1, "name is required")
        .max(200, "name must be at most 200 characters"),
    email: emailSchema,
    phone: z.string().trim().min(1).max(30, "phone must be at most 30 characters").optional(),
});
export const checkoutSchema = z
    .object({
    customer: checkoutCustomerSchema,
    items: z
        .array(checkoutItemSchema)
        .min(1, "cart must contain at least one item")
        .max(50, "cart must contain at most 50 items"),
    // Optional managed discount code (dashboard-discounts.md); computed
    // server-side. Checkout applies no group discounts — buyers are
    // anonymous.
    discountCode: z
        .string()
        .trim()
        .min(3, "discountCode must be at least 3 characters")
        .max(40, "discountCode must be at most 40 characters")
        .regex(/^[A-Za-z0-9-]+$/, "discountCode may only contain letters, digits, and dashes")
        .optional(),
    // How the storefront buyer wants to pay. "bank_transfer" skips the
    // payment provider entirely and returns the merchant's bank details +
    // a reference at checkout; the customer pays manually and the merchant
    // confirms. "paystack" is the default and routes through the provider.
    paymentMethod: z.enum(["paystack", "bank_transfer"]).optional().default("paystack"),
    // How the buyer reached the storefront: maps 1:1 onto OrderSource
    // (analytics revenue-by-channel attribution). Omitted defaults to
    // STOREFRONT.
    origin: z.enum(["DIRECT", "SOCIAL", "MARKETPLACE", "REFERRAL"]).optional(),
    // Fulfilment (dashboard-delivery-options.md): the chosen option plus,
    // for a DELIVERY option, the customer's own address. Required-ness is
    // enforced in the service, which knows the store's options and their
    // kinds. The fee always comes from the option's baseFee — never a
    // client-supplied amount.
    deliveryOptionId: z.string().uuid("deliveryOptionId must be a valid UUID").optional(),
    deliveryAddress: z
        .string()
        .trim()
        .min(1, "deliveryAddress must not be empty")
        .max(500, "deliveryAddress must be at most 500 characters")
        .optional(),
    deliveryCity: z
        .string()
        .trim()
        .min(1, "deliveryCity must not be empty")
        .max(120, "deliveryCity must be at most 120 characters")
        .optional(),
    deliveryState: z
        .string()
        .trim()
        .min(1, "deliveryState must not be empty")
        .max(120, "deliveryState must be at most 120 characters")
        .optional(),
    deliveryPhone: z
        .string()
        .trim()
        .min(1, "deliveryPhone must not be empty")
        .max(30, "deliveryPhone must be at most 30 characters")
        .optional(),
    deliveryInstructions: z
        .string()
        .trim()
        .max(500, "deliveryInstructions must be at most 500 characters")
        .optional(),
})
    .strict();
/**
 * POS money field: number or decimal string, normalized to a "0.00"
 * string. Accepts 0.00 (a zero discount / a credit sale with nothing
 * paid yet) — unlike product pricing, which is strictly positive.
 */
const posMoneySchema = z
    .union([
    z.number(),
    z.string().regex(/^\d+(?:\.\d{1,2})?$/, "must be a number with at most 2 decimal places"),
])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value >= 0, "must be 0 or greater")
    .refine((value) => value <= 99_999_999.99, "exceeds the maximum of 99999999.99")
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, "must have at most 2 decimal places")
    .transform((value) => value.toFixed(2));
/**
 * POS record-sale payload (POST /api/dashboard/orders). Prices are NEVER
 * client-supplied: items carry product ids (and optional variant ids)
 * and quantities only; unit prices and totals are resolved from the
 * database at record time (dashboard-pos.md).
 */
export const posSaleSchema = z
    .object({
    items: z
        .array(checkoutItemSchema)
        .min(1, "cart must contain at least one item")
        .max(50, "cart must contain at most 50 items"),
    // The branch whose stock this sale decrements; defaults to the
    // store's default branch when omitted.
    branchId: z.string().uuid("branchId must be a valid UUID").optional(),
    // Omitted = walk-in sale (the store's shared Walk-in Customer row).
    customerId: z.string().uuid("customerId must be a valid UUID").optional(),
    paymentMethod: z.enum(["CASH", "TRANSFER", "CREDIT", "CARD"]),
    // Managed discount (dashboard-discounts.md): exactly one of id/code,
    // computed server-side. Neither is the same as no discount — the
    // customer's group discount then auto-applies at the POS.
    discountId: z.string().uuid("discountId must be a valid UUID").optional(),
    discountCode: z
        .string()
        .trim()
        .min(3, "discountCode must be at least 3 characters")
        .max(40, "discountCode must be at most 40 characters")
        .regex(/^[A-Za-z0-9-]+$/, "discountCode may only contain letters, digits, and dashes")
        .optional(),
    // What the customer paid now. Default: the total for CASH/TRANSFER,
    // 0.00 for CREDIT; ignored for CARD (the provider is the only source
    // of payment truth there).
    amountPaid: posMoneySchema.optional(),
    // Receipt/invoice email for the payment provider — REQUIRED for CARD
    // when the chosen customer has no email.
    email: emailSchema.optional(),
})
    .strict()
    .refine((data) => !(data.discountId !== undefined && data.discountCode !== undefined), {
    message: "discountId and discountCode are mutually exclusive",
});
/** GET /api/dashboard/orders query params (cursor-based pagination). */
export const listOrdersParamsSchema = z.object({
    status: z
        .enum(["PENDING", "AWAITING_PAYMENT", "PAID", "SHIPPED", "CANCELLED", "REFUNDED", "FAILED"])
        .optional(),
    paymentMethod: z.enum(["CASH", "TRANSFER", "CREDIT", "CARD"]).optional(),
    source: z.enum(["STOREFRONT", "POS"]).optional(),
    start: z.iso.datetime({ offset: true }).optional(),
    end: z.iso.datetime({ offset: true }).optional(),
    q: z
        .string()
        .trim()
        .min(1, "q must not be empty")
        .max(200, "q must be at most 200 characters")
        .optional(),
    // Address-book integration (dashboard-customers.md): one customer's orders.
    customerId: z.string().uuid("customerId must be a valid UUID").optional(),
    limit: z.coerce
        .number({ error: "limit must be a number" })
        .int("limit must be an integer")
        .min(1, "limit must be at least 1")
        .max(100, "limit must be at most 100")
        .default(20),
    cursor: z.string().uuid("cursor must be a valid UUID").optional(),
});
/**
 * Bank-transfer confirm body. The merchant re-enters the amount the
 * customer claimed to transfer; it must match the order total exactly
 * (validated against the DB, not the client). Coerced so an empty or
 * malformed string is a clean 400 rather than a 422 mismatch.
 */
export const confirmBankTransferSchema = z
    .object({
    confirmedAmount: z
        .union([
        z.coerce.number({ error: "confirmedAmount must be a number" }),
        z.string().regex(/^\d+(?:\.\d{1,2})?$/, "must be a number with at most 2 decimal places"),
    ])
        .transform((value) => Number(value))
        .refine((value) => Number.isFinite(value) && value > 0, "must be greater than 0")
        .refine((value) => value <= 99_999_999.99, "exceeds the maximum of 99999999.99"),
})
    .strict();
//# sourceMappingURL=schemas.js.map