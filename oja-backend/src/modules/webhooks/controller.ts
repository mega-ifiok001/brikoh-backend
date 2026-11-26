import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { AppError } from "../../lib/AppError.js";
import { env } from "../../config/env.js";
import { handlePaystackWebhook } from "./service.js";
import { handlePaystackSubscriptionWebhook } from "./subscriptionWebhook.service.js";
import { processShipbubbleWebhook } from "../orders/shipbubble-webhook.service.js";

/** POST /api/webhooks/paystack */
export async function paystackWebhookHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rawBody = req.rawBody;
    if (rawBody === undefined) {
      throw new AppError(400, "VALIDATION_ERROR", "Missing raw request body");
    }
    const outcome = await handlePaystackWebhook(rawBody, req.get("x-paystack-signature") ?? "");
    void outcome;
    res.status(200).json({ accepted: true });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/webhooks/paystack-subscriptions — platform recurring billing.
 * The signature is verified against PLATFORM_PAYSTACK_SECRET_KEY (a separate
 * trust domain from the merchant-key order webhook above).
 */
export async function paystackSubscriptionWebhookHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rawBody = req.rawBody;
    if (rawBody === undefined) {
      throw new AppError(400, "VALIDATION_ERROR", "Missing raw request body");
    }
    const outcome = await handlePaystackSubscriptionWebhook(
      rawBody,
      req.get("x-paystack-signature") ?? "",
    );
    void outcome;
    res.status(200).json({ accepted: true });
  } catch (err) {
    next(err);
  }
}

/** POST /api/webhooks/shipbubble/:webhookSecret */
export async function shipbubbleWebhookHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const configuredSecret = env.SHIPBUBBLE_WEBHOOK_SECRET;
    const providedSecret = req.params.webhookSecret;
    if (configuredSecret === undefined || typeof providedSecret !== "string") {
      throw new AppError(401, "INVALID_WEBHOOK_SECRET", "Invalid webhook credential");
    }
    const expected = Buffer.from(configuredSecret);
    const provided = Buffer.from(providedSecret);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new AppError(401, "INVALID_WEBHOOK_SECRET", "Invalid webhook credential");
    }
    const outcome = await processShipbubbleWebhook(req.body);
    res.status(200).json(outcome);
  } catch (err) {
    next(err);
  }
}
