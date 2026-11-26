import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { validateTransactionExportQuery, validateTransactionQuery } from "./schemas.js";
import { TransactionsService } from "./service.js";

const transactions = new TransactionsService();

function requireMoneyAccess(req: Request): { storeId: string } {
  const tenant = req.tenant;
  if (tenant === undefined) throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  if (!tenant.permissions.includes("viewProfit")) {
    throw new AppError(
      403,
      "ACCESS_DENIED",
      "You don't have permission to view transaction history",
    );
  }
  return { storeId: tenant.storeId };
}

export async function listTransactionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireMoneyAccess(req);
    res.status(200).json(await transactions.list(storeId, validateTransactionQuery(req.query)));
  } catch (err) {
    next(err);
  }
}

export async function getTransactionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireMoneyAccess(req);
    const transactionId = req.params.transactionId;
    if (typeof transactionId !== "string") {
      throw new AppError(400, "INVALID_TRANSACTION_ID", "Transaction ID is required");
    }
    res.status(200).json({ transaction: await transactions.detail(storeId, transactionId) });
  } catch (err) {
    next(err);
  }
}

export async function exportTransactionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireMoneyAccess(req);
    const query = validateTransactionExportQuery(req.query);
    const csv = await transactions.exportCsv(storeId, query);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="transactions-${query.from}_${query.to}.csv"`,
    );
    res.status(200).send(csv);
  } catch (err) {
    next(err);
  }
}
