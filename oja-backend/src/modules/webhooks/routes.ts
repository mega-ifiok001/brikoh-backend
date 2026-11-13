import { Router } from "express";
import {
  paystackSubscriptionWebhookHandler,
  paystackWebhookHandler,
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

export { webhooksRouter };
