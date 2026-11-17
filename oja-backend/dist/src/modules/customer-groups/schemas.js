import { z } from "zod";
export { validateOrThrow } from "../../lib/validate.js";
/**
 * ============================================================
 * CUSTOMER GROUPS SCHEMAS
 * ============================================================
 * A group is a store-scoped label (name unique per store,
 * case-insensitive at the DB via the (storeId, name) unique pair) with
 * an optional attached auto-applied discount. Updates accept explicit
 * null to clear description/discountId.
 */
export const customerGroupNameSchema = z
    .string()
    .trim()
    .min(1, "name is required")
    .max(100, "name must be at most 100 characters");
const descriptionSchema = z.string().trim().max(500, "description must be at most 500 characters");
const discountIdSchema = z.string().uuid("discountId must be a valid UUID");
export const customerGroupCreateSchema = z
    .object({
    name: customerGroupNameSchema,
    description: descriptionSchema.nullable().optional(),
    discountId: discountIdSchema.nullable().optional(),
})
    .strict();
export const customerGroupUpdateSchema = z
    .object({
    name: customerGroupNameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    discountId: discountIdSchema.nullable().optional(),
})
    .strict()
    .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "at least one field is required",
});
//# sourceMappingURL=schemas.js.map