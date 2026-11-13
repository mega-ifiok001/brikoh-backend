import { Router } from "express";
import { rateLimit } from "../../middleware/rateLimit.js";
import {
  createExpenseHandler,
  deleteExpenseHandler,
  listExpensesHandler,
  updateExpenseHandler,
} from "./controller.js";

/**
 * Expenses (mount: /api/dashboard/expenses — authenticate +
 * resolveTenant + authorize("analytics.manage")). Writes get the
 * payments baseline limiter (60/min): expenses are money-adjacent like
 * the other tenant resources.
 */
const expensesRouter: Router = Router();
expensesRouter.get("/", listExpensesHandler);
expensesRouter.post("/", rateLimit({ windowMs: 60_000, max: 60 }), createExpenseHandler);
expensesRouter.put("/:expenseId", rateLimit({ windowMs: 60_000, max: 60 }), updateExpenseHandler);
expensesRouter.delete(
  "/:expenseId",
  rateLimit({ windowMs: 60_000, max: 60 }),
  deleteExpenseHandler,
);

export { expensesRouter };
