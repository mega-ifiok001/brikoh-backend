import { Router } from "express";
import {
  paystackSubscriptionWebhookHandler,
  paystackWebhookHandler,
  shipbubbleWebhookHandler,
} from "./controller.js";

const webhooksRouter: Router = Router();

// The x-paystack-signature header is the credential; the handler must
// receive the EXACT raw bytes, so the body is captured by the global
// express.json verify hook (app.ts) into req.rawBody.
webhooksRouter.post("/paystack", paystackWebhookHandler);

// Platform recurring billing (merchant subscriptions). Separate endpoint +
// separate signature domain (PLATFORM_PAYSTACK_SECRET_KEY) from the order
// webhook above.
webhooksRouter.post("/paystack-subscriptions", paystackSubscriptionWebhookHandler);
// Shipbubble's published webhook docs do not specify a signature header;
// the configured high-entropy callback path is the bearer credential.
webhooksRouter.post("/shipbubble/:webhookSecret", shipbubbleWebhookHandler);

export { webhooksRouter };
