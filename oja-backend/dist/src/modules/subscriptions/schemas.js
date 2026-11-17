import { z } from "zod";
/** Validated hostname: lowercase labels, no scheme, no path, no port. */
const hostnamePattern = /^(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const setCustomDomainSchema = z.object({
    customDomain: z
        .string()
        .trim()
        .toLowerCase()
        .min(4, "customDomain is too short")
        .max(253, "customDomain is too long")
        .regex(hostnamePattern, "customDomain must be a valid hostname (e.g. shop.example.com)"),
});
/** The billable tiers a merchant may self-serve. */
export const subscriptionTierSchema = z.enum(["STARTER", "PRO", "ENTERPRISE"]);
export const subscriptionCheckoutSchema = z
    .object({ tier: subscriptionTierSchema })
    .strict();
/** Upgrade/downgrade target tier — same shape as checkout. */
export const subscriptionChangeTierSchema = subscriptionCheckoutSchema;
//# sourceMappingURL=schemas.js.map