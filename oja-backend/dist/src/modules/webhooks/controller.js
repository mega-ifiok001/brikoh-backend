import { AppError } from "../../lib/AppError.js";
import { handlePaystackWebhook } from "./service.js";
import { handlePaystackSubscriptionWebhook } from "./subscriptionWebhook.service.js";
/** POST /api/webhooks/paystack */
export async function paystackWebhookHandler(req, res, next) {
    try {
        const rawBody = req.rawBody;
        if (rawBody === undefined) {
            throw new AppError(400, "VALIDATION_ERROR", "Missing raw request body");
        }
        const outcome = await handlePaystackWebhook(rawBody, req.get("x-paystack-signature") ?? "");
        void outcome;
        res.status(200).json({ accepted: true });
    }
    catch (err) {
        next(err);
    }
}
/**
 * POST /api/webhooks/paystack-subscriptions — platform recurring billing.
 * The signature is verified against PLATFORM_PAYSTACK_SECRET_KEY (a separate
 * trust domain from the merchant-key order webhook above).
 */
export async function paystackSubscriptionWebhookHandler(req, res, next) {
    try {
        const rawBody = req.rawBody;
        if (rawBody === undefined) {
            throw new AppError(400, "VALIDATION_ERROR", "Missing raw request body");
        }
        const outcome = await handlePaystackSubscriptionWebhook(rawBody, req.get("x-paystack-signature") ?? "");
        void outcome;
        res.status(200).json({ accepted: true });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map