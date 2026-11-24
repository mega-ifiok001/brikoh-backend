import { z } from "zod";
import { validateOrThrow } from "../../lib/validate.js";

export { validateOrThrow };

/**
 * Paystack webhook payload — the parts the backend needs. `data.id` is
 * Paystack's event id and the dedup key; `reference` is the order's
 * payment reference (ord_…) or the payout's withdrawal reference (wd_…)
 * echoed by Paystack. Transfer events additionally carry the transfer
 * code and (on transfer.success) the fee in kobo.
 */
export const paystackWebhookSchema = z.object({
  event: z.string().min(1),
  data: z.object({
    id: z.string().min(1),
    reference: z.string().min(1),
    status: z.string().optional(),
    transfer_code: z.string().optional(),
    fee: z.number().optional(),
    // Paystack reports charge fees in subunits (kobo) on charge.success.
    fees: z.number().int().nonnegative().optional(),
  }),
});

export type PaystackWebhookPayload = z.infer<typeof paystackWebhookSchema>;

/**
 * Subscription webhook payload (platform Paystack account). The data shape
 * covers charge.success / charge.failed / subscription.* / invoice.* events
 * for the platform's recurring billing. Only the fields the backend needs
 * are captured; everything else is ignored.
 */
export const subscriptionWebhookSchema = z.object({
  event: z.string().min(1),
  data: z.object({
    id: z.string().min(1),
    reference: z.string().optional(),
    status: z.string().optional(),
    amount: z.number().optional(),
    // charge.* data nests the plan + subscription objects.
    plan: z.object({ plan_code: z.string().optional() }).optional(),
    subscription: z
      .object({
        subscription_code: z.string().optional(),
        email_token: z.string().optional(),
        status: z.string().optional(),
      })
      .optional(),
    // invoice.* / subscription.* events carry the subscription code here.
    subscription_code: z.string().optional(),
    email_token: z.string().optional(),
  }),
});

export type SubscriptionWebhookPayload = z.infer<typeof subscriptionWebhookSchema>;
