import { z } from "zod";
import { validateOrThrow } from "../../lib/validate.js";
export { validateOrThrow };
/** 10-digit NUBAN account number. */
const nubanSchema = z.string().regex(/^\d{10}$/, "accountNumber must be a 10-digit account number");
/** 3-digit Paystack bank code. */
const bankCodeSchema = z.string().regex(/^\d{3}$/, "bankCode must be a 3-digit code");
/** Decimal-string money ("1234.56"). */
const amountSchema = z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, "amount must be a decimal string with at most 2 decimals");
export const createBankAccountSchema = z.object({
    accountName: z.string().trim().min(1).optional(),
    accountNumber: nubanSchema,
    bankName: z.string().trim().min(1),
    bankCode: bankCodeSchema,
    isDefault: z.boolean().optional(),
});
export const createWithdrawalSchema = z.object({
    bankAccountId: z.string().uuid(),
    amount: amountSchema,
});
export const listWithdrawalsParamsSchema = z.object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
});
//# sourceMappingURL=schemas.js.map