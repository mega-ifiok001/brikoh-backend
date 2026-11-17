import { Router, text } from "express";
import { rateLimit } from "../../middleware/rateLimit.js";
import { createCustomerHandler, deleteCustomerHandler, exportCustomersHandler, getCustomerDetailHandler, importCustomersHandler, listCustomersHandler, recordCreditRepaymentHandler, updateCustomerHandler, } from "./controller.js";
/**
 * Customers (mount: /api/dashboard/customers — authenticate +
 * resolveTenant + authorize("customers.manage")). Writes and the
 * money-touching repayment route get the payments baseline limiter
 * (60/min) like the POS record-sale route. The repayment route is
 * declared FIRST so "credits/repayments" is never swallowed as a
 * customerId.
 */
const customersRouter = Router();
customersRouter.post("/:customerId/credits/repayments", rateLimit({ windowMs: 60_000, max: 60 }), recordCreditRepaymentHandler);
customersRouter.get("/", listCustomersHandler);
// Static routes before the parametric :customerId (export.csv must not
// be read as a customer id). The import route parses a raw CSV body —
// express.json never sees it.
customersRouter.get("/export.csv", exportCustomersHandler);
customersRouter.post("/import", rateLimit({ windowMs: 60_000, max: 60 }), text({ type: "text/csv", limit: "2mb" }), importCustomersHandler);
customersRouter.post("/", rateLimit({ windowMs: 60_000, max: 60 }), createCustomerHandler);
customersRouter.get("/:customerId", getCustomerDetailHandler);
customersRouter.put("/:customerId", rateLimit({ windowMs: 60_000, max: 60 }), updateCustomerHandler);
customersRouter.delete("/:customerId", rateLimit({ windowMs: 60_000, max: 60 }), deleteCustomerHandler);
export { customersRouter };
//# sourceMappingURL=routes.js.map