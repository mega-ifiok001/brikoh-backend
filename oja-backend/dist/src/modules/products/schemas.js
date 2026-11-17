import { z } from "zod";
/**
 * Money is Decimal(10,2) in the DB. The API accepts a JSON number or a
 * decimal string (up to 2dp, positive, capped at 99999999.99) and
 * normalizes it to a 2dp string ("12.50") so Prisma stores the exact
 * value — never a float with hidden precision loss.
 */
export const priceSchema = z
    .union([
    z.number(),
    z.string().regex(/^\d+(?:\.\d{1,2})?$/, "price must be a number with at most 2 decimal places"),
])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value > 0, "price must be greater than 0")
    .refine((value) => value <= 99_999_999.99, "price exceeds the maximum of 99999999.99")
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, "price must have at most 2 decimal places")
    .transform((value) => value.toFixed(2));
/**
 * The merchant's cost (what they paid their supplier) — same decimal
 * normalization as price, but OPTIONAL and zero-allowed: many merchants
 * won't track costs, and a free/gifted unit can legitimately cost 0.
 * Nothing reads it yet; this phase only makes the field exist and be
 * settable.
 */
export const costPriceSchema = z
    .union([
    z.number(),
    z
        .string()
        .regex(/^\d+(?:\.\d{1,2})?$/, "costPrice must be a number with at most 2 decimal places"),
])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value >= 0, "costPrice must be 0 or greater")
    .refine((value) => value <= 99_999_999.99, "costPrice exceeds the maximum of 99999999.99")
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, "costPrice must have at most 2 decimal places")
    .transform((value) => value.toFixed(2));
const nameSchema = z
    .string()
    .trim()
    .min(1, "name is required")
    .max(120, "name must be at most 120 characters");
/** Product-level SKU — the variant-level one lives on productVariantSchema.
 * Null clears it on update; absent leaves it untouched. */
const productSkuSchema = z
    .string()
    .trim()
    .min(1, "sku must not be empty")
    .max(64, "sku must be at most 64 characters")
    .nullable();
const descriptionSchema = z
    .string()
    .trim()
    .max(2000, "description must be at most 2000 characters")
    .nullable();
const imagesSchema = z
    .array(z.url("each image must be a valid URL"))
    .max(10, "at most 10 images are allowed");
const coverImageUrlSchema = z
    .url("coverImageUrl must be a valid URL")
    .max(2048, "coverImageUrl must be at most 2048 characters")
    .nullable();
const lowStockThresholdSchema = z
    .number({ error: "lowStockThreshold must be a number" })
    .int("lowStockThreshold must be an integer")
    .min(0, "lowStockThreshold must be 0 or greater")
    .nullable();
const expiryDateSchema = z
    .union([
    z.iso.datetime({
        offset: true,
        error: "expiryDate must be an ISO 8601 datetime with timezone",
    }),
    z
        .string()
        .refine((value) => !Number.isNaN(Date.parse(value)), "expiryDate must be a valid date"),
])
    .transform((value) => new Date(value))
    .nullable();
/**
 * The promotional price — same decimal normalization as `price`, but the
 * object-level refines below enforce that a discount actually discounts
 * (discountPrice < price when both are set).
 */
export const discountPriceSchema = z
    .union([
    z.number(),
    z
        .string()
        .regex(/^\d+(?:\.\d{1,2})?$/, "discountPrice must be a number with at most 2 decimal places"),
])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value > 0, "discountPrice must be greater than 0")
    .refine((value) => value <= 99_999_999.99, "discountPrice exceeds the maximum of 99999999.99")
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, "discountPrice must have at most 2 decimal places")
    .transform((value) => value.toFixed(2));
/** A categoryId/unitId reference: non-empty string, validated for tenant
 * ownership by the service layer (404 when unknown or cross-tenant). */
const catalogRefSchema = z.string().trim().min(1, "id must not be empty").max(64);
// .strict(): unknown keys (e.g. an attempt to sneak `quantity` through
// the product endpoints) are rejected instead of silently stripped —
// stock changes ONLY via the stock-adjustment endpoint (or the
// create-time initialStock seed below).
// A variant's `name` is optional and derived from its option values
// ("Red / M") when omitted. Dimensions/values are managed through the
// dedicated option-variant routes, never through updateProduct.
export const productVariantSchema = z
    .object({
    name: nameSchema,
    // Overrides the parent product's price when set; null/absent = the
    // product's price applies.
    sellingPrice: priceSchema.nullable().optional(),
    sku: z
        .string()
        .trim()
        .min(1, "sku must not be empty")
        .max(64, "sku must be at most 64 characters")
        .nullable()
        .optional(),
    // Starting stock for THIS variant (a seed INITIAL_STOCK ledger
    // entry is written per variant inside the create transaction).
    initialStock: z
        .number({ error: "initialStock must be a number" })
        .int("initialStock must be an integer")
        .min(1, "initialStock must be at least 1")
        .max(1_000_000, "initialStock must be at most 1000000")
        .optional(),
})
    .strict();
const variantsSchema = z
    .array(productVariantSchema)
    .max(50, "at most 50 variants are allowed per product");
/** Max option dimensions per product (mirrors Bumpa's 2-option limit). */
export const MAX_PRODUCT_OPTIONS = 2;
const optionTextSchema = z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(40, "must be at most 40 characters");
/** One option dimension + its values, as supplied to PUT /options. */
export const productOptionInputSchema = z
    .object({
    name: optionTextSchema,
    values: z.array(optionTextSchema).min(1, "an option needs at least one value").max(50),
})
    .strict();
export const productOptionsSchema = z
    .array(productOptionInputSchema)
    .max(MAX_PRODUCT_OPTIONS, `at most ${MAX_PRODUCT_OPTIONS} options are allowed per product`)
    .refine((options) => new Set(options.map((o) => o.name.toLowerCase())).size === options.length, { message: "option names must be unique" });
export const setProductOptionsSchema = z
    .object({ options: productOptionsSchema })
    .strict();
/** POST /products/:productId/variants — add a single variant. */
export const variantCreateSchema = z
    .object({
    name: nameSchema.optional(),
    sellingPrice: priceSchema.nullable().optional(),
    sku: z
        .string()
        .trim()
        .min(1, "sku must not be empty")
        .max(64, "sku must be at most 64 characters")
        .nullable()
        .optional(),
    initialStock: z
        .number({ error: "initialStock must be a number" })
        .int("initialStock must be an integer")
        .min(1, "initialStock must be at least 1")
        .max(1_000_000, "initialStock must be at most 1000000")
        .optional(),
    optionValues: z
        .array(z
        .object({ option: optionTextSchema, value: optionTextSchema })
        .strict())
        .max(MAX_PRODUCT_OPTIONS)
        .optional(),
})
    .strict();
/** PATCH /products/:productId/variants/:variantId — edit label/price/SKU. */
export const variantUpdateSchema = z
    .object({
    name: nameSchema,
    sellingPrice: priceSchema.nullable(),
    sku: z
        .string()
        .trim()
        .min(1, "sku must not be empty")
        .max(64, "sku must be at most 64 characters")
        .nullable(),
})
    .strict()
    .partial()
    .refine((data) => Object.keys(data).length > 0, { message: "at least one field is required" });
export const createProductSchema = z
    .object({
    name: nameSchema,
    sku: productSkuSchema.optional().nullable(),
    price: priceSchema,
    costPrice: costPriceSchema.optional().nullable(),
    description: descriptionSchema.optional(),
    images: imagesSchema.optional().default([]),
    coverImageUrl: coverImageUrlSchema.optional(),
    discountPrice: discountPriceSchema.optional().nullable(),
    lowStockThreshold: lowStockThresholdSchema.optional(),
    expiryDate: expiryDateSchema.optional(),
    categoryId: catalogRefSchema.optional().nullable(),
    unitId: catalogRefSchema.optional().nullable(),
    // Starting stock for a variant-less product — seeded as an
    // INITIAL_STOCK ledger entry inside the create transaction.
    initialStock: z
        .number({ error: "initialStock must be a number" })
        .int("initialStock must be an integer")
        .min(1, "initialStock must be at least 1")
        .max(1_000_000, "initialStock must be at most 1000000")
        .optional(),
    variants: variantsSchema.optional().default([]),
    // Dimensions → an auto-generated variant grid (cartesian product).
    // Mutually exclusive with `variants` and `initialStock`.
    options: productOptionsSchema.optional().default([]),
})
    .strict()
    .refine((data) => data.initialStock === undefined ||
    (data.variants.length === 0 && data.options.length === 0), {
    message: "initialStock applies to variant-less products only — set initialStock per variant instead",
    path: ["initialStock"],
})
    .refine((data) => !(data.variants.length > 0 && data.options.length > 0), {
    message: "provide either `variants` or `options`, not both",
    path: ["options"],
})
    .refine((data) => data.discountPrice === null ||
    data.discountPrice === undefined ||
    Number(data.discountPrice) < Number(data.price), { message: "discountPrice must be lower than price", path: ["discountPrice"] });
export const updateProductSchema = z
    .object({
    name: nameSchema,
    sku: productSkuSchema,
    price: priceSchema,
    costPrice: costPriceSchema.nullable(),
    description: descriptionSchema,
    images: imagesSchema,
    coverImageUrl: coverImageUrlSchema,
    discountPrice: discountPriceSchema.nullable(),
    lowStockThreshold: lowStockThresholdSchema,
    expiryDate: expiryDateSchema,
    categoryId: catalogRefSchema.nullable(),
    unitId: catalogRefSchema.nullable(),
})
    .strict()
    .partial()
    .refine((data) => data.discountPrice === undefined ||
    data.discountPrice === null ||
    data.price === undefined ||
    Number(data.discountPrice) < Number(data.price), { message: "discountPrice must be lower than price", path: ["discountPrice"] });
export const listProductsParamsSchema = z.object({
    limit: z.coerce
        .number({ error: "limit must be a number" })
        .int("limit must be an integer")
        .min(1, "limit must be at least 1")
        .max(200, "limit must be at most 200")
        .default(50),
    cursor: z.string().trim().min(1, "cursor must be a product id").optional(),
});
/**
 * Public storefront catalog query. `limit` mirrors the dashboard list;
 * `cursor` is validated as a uuid so a malformed page link is a clean
 * 400 rather than a 500. `categoryId` (also uuid-validated) is a filter,
 * not a resource — an unknown/other-store id yields an empty 200, never
 * a 404. `q` is a name-only substring search.
 */
export const listPublicProductsParamsSchema = z.object({
    limit: z.coerce
        .number({ error: "limit must be a number" })
        .int("limit must be an integer")
        .min(1, "limit must be at least 1")
        .max(200, "limit must be at most 200")
        .default(50),
    cursor: z
        .string()
        .uuid("That page link is invalid — please start from the first page")
        .optional(),
    categoryId: z.string().uuid("The selected category isn't valid").optional(),
    q: z.string().trim().max(120, "search must be at most 120 characters").optional(),
});
/**
 * Stock adjustment body (POST .../stock-adjustments). branchId and
 * productId come from the route context (controller), so only the
 * mutable fields are validated here. `reason` accepts the full
 * StockReason enum — the service stays the authority on which reasons
 * are legal through this endpoint (SALE and INITIAL_STOCK are rejected
 * there with INVALID_STOCK_REASON).
 */
export const stockAdjustmentSchema = z
    .object({
    branchId: z.string().uuid("branchId must be a valid UUID"),
    variantId: z.string().uuid("variantId must be a valid UUID").optional(),
    quantityChange: z
        .number({ error: "quantityChange must be a number" })
        .int("quantityChange must be an integer")
        .refine((v) => v !== 0, "quantityChange must not be zero"),
    reason: z.enum([
        "INITIAL_STOCK",
        "SALE",
        "MANUAL_ADJUSTMENT",
        "RESTOCK",
        "REFUND",
        "WRITE_OFF",
        "TRANSFER_OUT",
        "TRANSFER_IN",
    ], { error: "reason must be a valid stock reason" }),
    referenceId: z
        .string()
        .trim()
        .min(1, "referenceId must not be empty")
        .max(255, "referenceId must be at most 255 characters")
        .optional(),
})
    .strict();
//# sourceMappingURL=schemas.js.map