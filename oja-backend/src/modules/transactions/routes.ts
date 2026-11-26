import { Router } from "express";
import {
  exportTransactionsHandler,
  getTransactionHandler,
  listTransactionsHandler,
} from "./controller.js";

const transactionsRouter: Router = Router();
transactionsRouter.get("/export.csv", exportTransactionsHandler);
transactionsRouter.get("/:transactionId", getTransactionHandler);
transactionsRouter.get("/", listTransactionsHandler);

export { transactionsRouter };
