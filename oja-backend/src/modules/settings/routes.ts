import { Router } from "express";
import { rateLimit } from "../../middleware/rateLimit.js";
import {
  createBankAccountHandler,
  createDeliveryOptionHandler,
  deleteDeliveryOptionHandler,
  getBusinessProfileHandler,
  getNotificationSettingsHandler,
  listBankAccountsHandler,
  listDeliveryOptionsHandler,
  updateBusinessProfileHandler,
  updateDeliveryOptionHandler,
  updateNotificationSettingsHandler,
} from "./controller.js";

const settingsRouter: Router = Router();

settingsRouter.get("/business", getBusinessProfileHandler);
settingsRouter.put("/business", updateBusinessProfileHandler);
settingsRouter.get("/notifications", getNotificationSettingsHandler);
settingsRouter.put("/notifications", updateNotificationSettingsHandler);
// Merchant bank accounts for manual bank-transfer payments (owner-only, like
// the rest of /api/dashboard/settings).
settingsRouter.get("/bank-accounts", listBankAccountsHandler);
settingsRouter.post("/bank-accounts", createBankAccountHandler);
// Delivery options: the fulfilment choices at storefront checkout. Writes
// get an extra per-route limiter (the settings group already limits reads).
const deliveryWriteLimit = rateLimit({ windowMs: 60_000, max: 60 });
settingsRouter.get("/delivery-options", listDeliveryOptionsHandler);
settingsRouter.post("/delivery-options", deliveryWriteLimit, createDeliveryOptionHandler);
settingsRouter.put(
  "/delivery-options/:optionId",
  deliveryWriteLimit,
  updateDeliveryOptionHandler,
);
settingsRouter.delete(
  "/delivery-options/:optionId",
  deliveryWriteLimit,
  deleteDeliveryOptionHandler,
);

export { settingsRouter };
