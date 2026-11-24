import { z } from "zod";
import { AppError } from "../../lib/AppError.js";

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must use YYYY-MM-DD format")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "must be a valid calendar date");

const transactionQueryBaseSchema = z
  .object({
    from: calendarDate,
    to: calendarDate,
    view: z.enum(["all", "wallet"]).default("all"),
    direction: z.enum(["IN", "OUT"]).optional(),
    type: z
      .enum([
        "SALE",
        "CREDIT_REPAYMENT",
        "INVOICE_PAYMENT",
        "WITHDRAWAL",
        "WITHDRAWAL_REVERSAL",
        "WALLET_ADJUSTMENT",
      ])
      .optional(),
    status: z.enum(["PENDING", "PROCESSING", "SUCCESS", "FAILED", "REFUNDED"]).optional(),
    method: z.enum(["CASH", "TRANSFER", "CREDIT", "CARD", "PAYSTACK", "MANUAL"]).optional(),
    branchId: z.uuid().optional(),
    search: z.string().trim().min(1).max(100).optional(),
    cursor: z.string().max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const transactionQuerySchema = transactionQueryBaseSchema
  .refine((value) => value.from <= value.to, {
    message: "from must be on or before to",
    path: ["to"],
  })
  .refine(
    (value) => {
      const from = Date.parse(`${value.from}T00:00:00.000Z`);
      const to = Date.parse(`${value.to}T00:00:00.000Z`);
      return to - from <= 366 * 86_400_000;
    },
    {
      message: "date range cannot exceed 367 calendar days",
      path: ["to"],
    },
  );

export const transactionExportQuerySchema = transactionQueryBaseSchema
  .omit({ cursor: true, limit: true })
  .refine((value) => value.from <= value.to, {
    message: "from must be on or before to",
    path: ["to"],
  })
  .refine(
    (value) => {
      const from = Date.parse(`${value.from}T00:00:00.000Z`);
      const to = Date.parse(`${value.to}T00:00:00.000Z`);
      return to - from <= 366 * 86_400_000;
    },
    {
      message: "date range cannot exceed 367 calendar days",
      path: ["to"],
    },
  );
export type TransactionQuery = z.infer<typeof transactionQuerySchema>;
export type TransactionExportQuery = z.infer<typeof transactionExportQuerySchema>;

export function validateTransactionQuery(query: unknown): TransactionQuery {
  const parsed = transactionQuerySchema.safeParse(query);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new AppError(400, "INVALID_TRANSACTION_FILTER", "Invalid transaction filters", detail);
  }
  return parsed.data;
}

export function validateTransactionExportQuery(query: unknown): TransactionExportQuery {
  const parsed = transactionExportQuerySchema.safeParse(query);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new AppError(400, "INVALID_TRANSACTION_FILTER", "Invalid transaction filters", detail);
  }
  return parsed.data;
}
