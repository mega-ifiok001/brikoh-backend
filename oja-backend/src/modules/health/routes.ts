import { Router } from "express";
import { getHealthHandler } from "./controller.js";

const healthRouter: Router = Router();

healthRouter.get("/", getHealthHandler);

export { healthRouter };
