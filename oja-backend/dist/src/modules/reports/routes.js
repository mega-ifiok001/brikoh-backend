import { Router } from "express";
import { expensesByCategoryCsvHandler, expensesByCategoryHandler, inventoryValuationCsvHandler, inventoryValuationHandler, pnlCsvHandler, pnlHandler, } from "./controller.js";
/**
 * Reports (mount: /api/dashboard/reports — authenticate + resolveTenant
 * + authorize("analytics.manage"); the handlers additionally require
 * viewProfit). Read-only, not rate-limited.
 */
const reportsRouter = Router();
reportsRouter.get("/pnl", pnlHandler);
reportsRouter.get("/expenses-by-category", expensesByCategoryHandler);
reportsRouter.get("/pnl/export.csv", pnlCsvHandler);
reportsRouter.get("/expenses-by-category/export.csv", expensesByCategoryCsvHandler);
reportsRouter.get("/inventory-valuation", inventoryValuationHandler);
reportsRouter.get("/inventory-valuation/export.csv", inventoryValuationCsvHandler);
export { reportsRouter };
//# sourceMappingURL=routes.js.map