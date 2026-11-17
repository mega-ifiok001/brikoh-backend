import { Router } from "express";
import { rateLimit } from "../../middleware/rateLimit.js";
import { createSupplierHandler, deleteSupplierHandler, getSupplierHandler, listSuppliersHandler, updateSupplierHandler, } from "./controller.js";
/**
 * Suppliers (mount: /api/dashboard/suppliers — authenticate +
 * resolveTenant + authorize("purchases.manage")). Writes get the
 * payments baseline limiter (60/min) like the invoices module; reads
 * are not rate-limited.
 */
const suppliersRouter = Router();
suppliersRouter.get("/", listSuppliersHandler);
suppliersRouter.post("/", rateLimit({ windowMs: 60_000, max: 60 }), createSupplierHandler);
suppliersRouter.get("/:supplierId", getSupplierHandler);
suppliersRouter.put("/:supplierId", rateLimit({ windowMs: 60_000, max: 60 }), updateSupplierHandler);
suppliersRouter.delete("/:supplierId", rateLimit({ windowMs: 60_000, max: 60 }), deleteSupplierHandler);
export { suppliersRouter };
//# sourceMappingURL=routes.js.map