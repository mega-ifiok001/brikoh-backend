import { Router } from "express";
import { rateLimit } from "../../middleware/rateLimit.js";
import { createDiscountHandler, deleteDiscountHandler, getDiscountHandler, listDiscountsHandler, updateDiscountHandler, } from "./controller.js";
/**
 * Discounts (mount: /api/dashboard/discounts — authenticate +
 * resolveTenant + authorize("discounts.manage")). Writes get the
 * payments baseline limiter (60/min); the discount changes pricing at
 * sale time, so it is money-adjacent like the other tenant resources.
 */
const discountsRouter = Router();
discountsRouter.get("/", listDiscountsHandler);
discountsRouter.post("/", rateLimit({ windowMs: 60_000, max: 60 }), createDiscountHandler);
discountsRouter.get("/:discountId", getDiscountHandler);
discountsRouter.put("/:discountId", rateLimit({ windowMs: 60_000, max: 60 }), updateDiscountHandler);
discountsRouter.delete("/:discountId", rateLimit({ windowMs: 60_000, max: 60 }), deleteDiscountHandler);
export { discountsRouter };
//# sourceMappingURL=routes.js.map