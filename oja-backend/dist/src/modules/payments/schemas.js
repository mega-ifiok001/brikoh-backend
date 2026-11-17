import { z } from "zod";
import { validateOrThrow } from "../../lib/validate.js";
export { validateOrThrow };
/**
 * Provider allowlist — the set of payment providers merchants may
 * configure. Adding a provider (OPAY, MONNIFY…) extends this enum AND
 * ships a matching lib/providers/<name>.ts implementation; no other
 * code changes.
 */
export const paymentProviderSchema = z.enum(["paystack"]);
/** Paystack keys always carry their mode segment: pk_test_ / pk_live_. */
const paystackPublicKeySchema = z
    .string()
    .regex(/^pk_(test|live)_[A-Za-z0-9]+$/, "publicKey must be a Paystack pk_ key");
const paystackSecretKeySchema = z
    .string()
    .regex(/^sk_(test|live)_[A-Za-z0-9]+$/, "secretKey must be a Paystack sk_ key");
export const setPaymentProviderSchema = z.object({
    provider: paymentProviderSchema,
    publicKey: paystackPublicKeySchema,
    secretKey: paystackSecretKeySchema,
});
//# sourceMappingURL=schemas.js.map