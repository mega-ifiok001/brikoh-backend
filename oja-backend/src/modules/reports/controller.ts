import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { parseReportRange } from "./schemas.js";
import { ReportsService, serializeCsv } from "./service.js";

const reports = new ReportsService();

/**
 * Reports handlers. The mount carries authenticate + resolveTenant +
 * authorize("analytics.manage"); the P&L surface additionally requires
 * viewProfit (owners hold the full permission set implicitly) because
 * net profit is the most sensitive number in the store.
 */

function requireProfitTenant(req: Request): { storeId: string } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "NEED_LOGIN", "Please log in to continue");
  }
  if (!tenant.permissions.includes("viewProfit")) {
    throw new AppError(403, "ACCESS_DENIED", "You don't have permission to view profit reports");
  }
  return { storeId: tenant.storeId };
}

function requireProfitAccess(req: Request): {
  storeId: string;
  date: string;
  start: Date;
  end: Date;
} {
  const { storeId } = requireProfitTenant(req);
  const { date, start, end } = parseReportRange(req.query);
  return { storeId, date, start, end };
}

function sendCsv(res: Response, filename: string, csv: string): void {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.status(200).send(csv);
}

/** GET /api/dashboard/reports/inventory-valuation */
export async function inventoryValuationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireProfitTenant(req);
    res.status(200).json(await reports.getInventoryValuation(storeId));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/reports/inventory-valuation/export.csv */
export async function inventoryValuationCsvHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireProfitTenant(req);
    sendCsv(
      res,
      "inventory-valuation.csv",
      serializeCsv(await reports.inventoryValuationCsvRows(storeId)),
    );
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/reports/pnl */
export async function pnlHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { storeId, start, end } = requireProfitAccess(req);
    res.status(200).json(await reports.getPnl(storeId, start, end));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/reports/expenses-by-category */
export async function expensesByCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, start, end } = requireProfitAccess(req);
    res.status(200).json(await reports.getExpensesByCategory(storeId, start, end));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/reports/pnl/export.csv */
export async function pnlCsvHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, date, start, end } = requireProfitAccess(req);
    const rows = await reports.pnlCsvRows(storeId, start, end);
    sendCsv(res, `pnl-${date}_${date}.csv`, serializeCsv(rows));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/reports/expenses-by-category/export.csv */
export async function expensesByCategoryCsvHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, date, start, end } = requireProfitAccess(req);
    const rows = await reports.categoryCsvRows(storeId, start, end);
    sendCsv(res, `expenses-by-category-${date}_${date}.csv`, serializeCsv(rows));
  } catch (err) {
    next(err);
  }
}
