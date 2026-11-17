import { Router } from "express";
import { presignProductImageHandler } from "./controller.js";
const uploadsRouter = Router();
uploadsRouter.post("/presign-product-image", presignProductImageHandler);
export { uploadsRouter };
//# sourceMappingURL=routes.js.map