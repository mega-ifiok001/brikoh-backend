import { Router } from "express";
import { getHealthHandler } from "./controller.js";
const healthRouter = Router();
healthRouter.get("/", getHealthHandler);
export { healthRouter };
//# sourceMappingURL=routes.js.map