import { z } from "zod";
import { emailSchema } from "../auth/schemas.js";
import { phoneSchema } from "../../lib/validation.js";
export { validateOrThrow } from "../../lib/validate.js";
/**
 * ============================================================
 * SUPPLIER SCHEMAS
 * ============================================================
 * The vendor directory: merchant-defined contacts the purchase-order
 * module draws from. Create and update are the same shape (PUT is a
 * full replace, like the catalog modules).
 */
export const supplierSchema = z
    .object({
    name: z
        .string()
        .trim()
        .min(1, "name is required")
        .max(100, "name must be at most 100 characters"),
    contactName: z
        .string()
        .trim()
        .min(1, "Contact name can't be empty")
        .max(100, "contactName must be at most 100 characters")
        .nullable()
        .optional(),
    phone: phoneSchema.nullable().optional(),
    email: emailSchema.nullable().optional(),
    address: z
        .string()
        .trim()
        .min(1, "address must not be empty")
        .max(200, "address must be at most 200 characters")
        .nullable()
        .optional(),
    isActive: z.boolean().optional(),
    notes: z
        .string()
        .trim()
        .min(1, "notes must not be empty")
        .max(1000, "notes must be at most 1000 characters")
        .nullable()
        .optional(),
})
    .strict();
export const createSupplierSchema = supplierSchema;
export const updateSupplierSchema = supplierSchema.refine((data) => Object.keys(data).length > 0, {
    message: "at least one field is required",
});
//# sourceMappingURL=schemas.js.map