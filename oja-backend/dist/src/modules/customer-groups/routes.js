import { Router } from "express";
import { rateLimit } from "../../middleware/rateLimit.js";
import { createCustomerGroupHandler, deleteCustomerGroupHandler, getCustomerGroupHandler, listCustomerGroupsHandler, updateCustomerGroupHandler, } from "./controller.js";
/**
 * Customer groups (mount: /api/dashboard/customer-groups — authenticate +
 * resolveTenant + authorize("customers.manage")). Writes get the
 * payments baseline limiter (60/min) like other money-adjacent tenant
 * resources.
 */
const customerGroupsRouter = Router();
customerGroupsRouter.get("/", listCustomerGroupsHandler);
customerGroupsRouter.post("/", rateLimit({ windowMs: 60_000, max: 60 }), createCustomerGroupHandler);
customerGroupsRouter.get("/:groupId", getCustomerGroupHandler);
customerGroupsRouter.put("/:groupId", rateLimit({ windowMs: 60_000, max: 60 }), updateCustomerGroupHandler);
customerGroupsRouter.delete("/:groupId", rateLimit({ windowMs: 60_000, max: 60 }), deleteCustomerGroupHandler);
export { customerGroupsRouter };
//# sourceMappingURL=routes.js.map