import { Router } from "express";
import { listStoreActivityHandler } from "./controller.js";
const activityRouter = Router();
activityRouter.get("/", listStoreActivityHandler);
export { activityRouter };
//# sourceMappingURL=routes.js.map