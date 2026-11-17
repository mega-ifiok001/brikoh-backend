import { Router } from "express";
import { getOverviewHandler } from "./controller.js";
const overviewRouter = Router();
overviewRouter.get("/", getOverviewHandler);
export { overviewRouter };
//# sourceMappingURL=routes.js.map