import { Router } from "express";
import { listStoreActivityHandler } from "./controller.js";

const activityRouter: Router = Router();

activityRouter.get("/", listStoreActivityHandler);

export { activityRouter };
