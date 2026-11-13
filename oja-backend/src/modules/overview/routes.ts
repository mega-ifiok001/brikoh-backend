import { Router } from "express";
import { getOverviewHandler } from "./controller.js";

const overviewRouter: Router = Router();

overviewRouter.get("/", getOverviewHandler);

export { overviewRouter };
