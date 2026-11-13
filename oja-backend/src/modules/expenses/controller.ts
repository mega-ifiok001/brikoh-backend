import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { createExpense, deleteExpense, listExpenses, updateExpense } from "./service.js";

function requireTenant(req: Request): { storeId: string; staffMemberId: string | undefined } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return { storeId: tenant.storeId, staffMemberId: tenant.staffMemberId };
}

function expenseIdParam(req: Request): string {
  const expenseId = req.params.expenseId;
  if (typeof expenseId !== "string" || expenseId === "") {
    throw new AppError(400, "VALIDATION_ERROR", "Expense ID is required");
  }
  return expenseId;
}

/** GET /api/dashboard/expenses */
export async function listExpensesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await listExpenses(storeId, req.query));
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/expenses */
export async function createExpenseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    const expense = await createExpense(storeId, staffMemberId, req.body);
    res.status(201).json({ expense });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/dashboard/expenses/:expenseId */
export async function updateExpenseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    const expense = await updateExpense(storeId, expenseIdParam(req), staffMemberId, req.body);
    res.status(200).json({ expense });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/dashboard/expenses/:expenseId */
export async function deleteExpenseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    await deleteExpense(storeId, expenseIdParam(req), staffMemberId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
