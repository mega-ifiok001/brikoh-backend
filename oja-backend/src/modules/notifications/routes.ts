import { Router } from "express";
import { listNotificationsHandler, sendTestAlertHandler } from "./controller.js";

const notificationsRouter: Router = Router();

// Recent alert dispatches (read-only inbox).
notificationsRouter.get("/", listNotificationsHandler);
// Test alert to the owner's mailbox.
notificationsRouter.post("/test", sendTestAlertHandler);

export { notificationsRouter };
