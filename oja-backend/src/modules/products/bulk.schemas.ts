import { z } from "zod";
import { costPriceSchema, priceSchema } from "./schemas.js";

/**
 * One row of a bulk import. Only `name` and `price` are required; every
 * other field is voluntary — omitted, empty, or null are equivalent
 * (mapped to null / [] / 0-stock in the persisted row). `.strict()` so a
 * malformed row (e.g. an attempt to sneak `variants` or `quantity`
 * through) is flagged as a per-row error, never silently stripped.
 */
export const bulkImportRowSchema = z
  .object({
    name: z
      .string({ error: "name is required" })
      .trim()
      .min(1, "name is required")
      .max(120, "name must be at most 120 characters"),
    price: priceSchema,
    costPrice: costPriceSchema.nullable().optional(),
    description: z
      .string()
      .trim()
      .max(2000, "description must be at most 2000 characters")
      .nullable()
      .optional(),
    images: z
      .array(z.url("each image must be a valid URL"))
      .max(10, "at most 10 images are allowed")
      .optional()
      .default([]),
    coverImageUrl: z
      .url("coverImageUrl must be a valid URL")
      .max(2048, "coverImageUrl must be at most 2048 characters")
      .nullable()
      .optional(),
    categoryId: z.string().trim().min(1, "id must not be empty").max(64).nullable().optional(),
    unitId: z.string().trim().min(1, "id must not be empty").max(64).nullable().optional(),
    initialStock: z
      .number({ error: "initialStock must be a number" })
      .int("initialStock must be an integer")
      .min(1, "initialStock must be at least 1")
      .max(1_000_000, "initialStock must be at most 1000000")
      .nullable()
      .optional(),
  })
  .strict();
export type BulkImportRowInput = z.infer<typeof bulkImportRowSchema>;

export const bulkImportSchema = z
  .object({
    // Rows are intentionally untyped at the array level: a single bad
    // row must flag THAT row, never fail the whole request (the service
    // validates each row with bulkImportRowSchema individually). The
    // array itself is bounded so a huge payload cannot slip through.
    rows: z
      .array(z.unknown())
      .min(1, "rows must contain at least 1 entry")
      .max(500, "rows must contain at most 500 entries"),
  })
  .strict();
export type BulkImportInput = z.infer<typeof bulkImportSchema>;

/**
 * The confirm request: the ticket id plus an explicit per-row duplicate
 * resolution (`overwrite` is the only write; everything unlisted or
 * `skip` is left untouched). Keys are row numbers as JSON object keys —
 * non-numeric keys are rejected by the service.
 */
export const bulkConfirmSchema = z
  .object({
    importId: z.string().trim().min(1, "importId is required").max(64),
    resolveDuplicates: z
      .record(z.string(), z.enum(["skip", "overwrite"]))
      .optional()
      .default({}),
  })
  .strict();
export type BulkConfirmInput = z.infer<typeof bulkConfirmSchema>;
