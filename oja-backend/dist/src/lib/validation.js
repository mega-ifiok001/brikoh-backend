import { z } from "zod";
/**
 * Shared validation building blocks. Kept deliberately small — module
 * schemas own their own shapes; only cross-module rules live here.
 */
/**
 * Phone numbers (personal Account.phone, Store.businessPhone): 7-17
 * chars of digits, optional leading +, spaces/dashes/parens allowed.
 */
export const phoneSchema = z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,17}$/, "phone must contain 7-17 digits and may start with +");
//# sourceMappingURL=validation.js.map