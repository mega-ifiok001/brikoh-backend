import { Router } from "express";
import { getPaymentProviderSettingsHandler, getSettlementStatusesHandler, setPaymentProviderSettingsHandler, } from "./controller.js";
const paymentsRouter = Router();
paymentsRouter.get("/provider", getPaymentProviderSettingsHandler);
paymentsRouter.put("/provider", setPaymentProviderSettingsHandler);
paymentsRouter.get("/settlements", getSettlementStatusesHandler);
export { paymentsRouter };
//# sourceMappingURL=routes.js.map