import { Router } from "express";
import { createLocationHandler, listLocationsHandler } from "./controller.js";

const locationsRouter: Router = Router();

locationsRouter.post("/", createLocationHandler);
locationsRouter.get("/", listLocationsHandler);

export { locationsRouter };
