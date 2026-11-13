import { z } from "zod";

const nameSchema = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(120, "name must be at most 120 characters");

const descriptionSchema = z
  .string()
  .trim()
  .max(1000, "description must be at most 1000 characters")
  .nullable()
  .optional();

const symbolSchema = z
  .string()
  .trim()
  .min(1, "symbol must not be empty")
  .max(16, "symbol must be at most 16 characters")
  .nullable()
  .optional();

// .strict(): unknown keys are rejected instead of silently stripped.
export const createCategorySchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema,
  })
  .strict();
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema,
  })
  .strict()
  .partial();
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const createUnitSchema = z
  .object({
    name: nameSchema,
    symbol: symbolSchema,
  })
  .strict();
export type CreateUnitInput = z.infer<typeof createUnitSchema>;

export const updateUnitSchema = z
  .object({
    name: nameSchema,
    symbol: symbolSchema,
  })
  .strict()
  .partial();
export type UpdateUnitInput = z.infer<typeof updateUnitSchema>;
