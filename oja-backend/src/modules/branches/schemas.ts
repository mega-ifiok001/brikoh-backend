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
export const createBranchSchema = z
  .object({
    name: nameSchema,
    address: addressSchema.optional(),
  })
  .strict();

export type CreateBranchInput = z.infer<typeof createBranchSchema>;

export const updateBranchSchema = z
  .object({
    name: nameSchema.optional(),
    address: addressSchema.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "at least one field (name, address) is required",
  });

export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;

export const setDefaultBranchSchema = z
  .object({
    branchId: z.string().trim().min(1, "Branch ID is required"),
  })
  .strict();

export type SetDefaultBranchInput = z.infer<typeof setDefaultBranchSchema>;

export const transferStockSchema = z
  .object({
    productId: z.string().trim().min(1, "Product ID is required"),
    variantId: z.string().trim().min(1, "Variant ID is invalid").optional(),
    sourceBranchId: z.string().trim().min(1, "Source branch is required"),
    destinationBranchId: z.string().trim().min(1, "Destination branch is required"),
    quantity: z
      .number()
      .int("quantity must be a whole number")
      .min(1, "quantity must be at least 1")
      .max(999999, "quantity must be at most 999999"),
  })
  .strict();

export type TransferStockInput = z.infer<typeof transferStockSchema>;
