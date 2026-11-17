import { Router } from "express";
import { createBranchHandler, deleteBranchHandler, getBranchHandler, listBranchesHandler, setDefaultBranchHandler, transferStockHandler, updateBranchHandler, } from "./controller.js";
// Branch CRUD + default management (locations.manage). The transfer
// route lives on its own router (mounted BEFORE this one in app.ts,
// under products.manage — stock movement is a products-module trust)
// so it can never be swallowed as a :branchId.
const branchesRouter = Router();
branchesRouter.post("/", createBranchHandler);
branchesRouter.get("/", listBranchesHandler);
branchesRouter.get("/:branchId", getBranchHandler);
branchesRouter.patch("/:branchId", updateBranchHandler);
branchesRouter.put("/:branchId/default", setDefaultBranchHandler);
branchesRouter.delete("/:branchId", deleteBranchHandler);
const branchTransfersRouter = Router();
branchTransfersRouter.post("/transfers", transferStockHandler);
export { branchTransfersRouter, branchesRouter };
//# sourceMappingURL=routes.js.map