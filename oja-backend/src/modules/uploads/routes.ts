import { Router } from "express";
import { presignProductImageHandler } from "./controller.js";

const uploadsRouter: Router = Router();

uploadsRouter.post("/presign-product-image", presignProductImageHandler);

export { uploadsRouter };
