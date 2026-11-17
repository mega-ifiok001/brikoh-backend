import { z } from "zod";
const nameSchema = z
    .string()
    .trim()
    .min(1, "name is required")
    .max(120, "name must be at most 120 characters");
const addressSchema = z
    .string()
    .trim()
    .max(500, "address must be at most 500 characters")
    .nullable();
// .strict(): unknown keys are rejected instead of silently stripped.
export const createLocationSchema = z
    .object({
    name: nameSchema,
    address: addressSchema.optional(),
})
    .strict();
//# sourceMappingURL=schemas.js.map