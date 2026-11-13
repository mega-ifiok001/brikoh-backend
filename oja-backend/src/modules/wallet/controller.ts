import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import {
  createBankAccount,
  createWithdrawal,
  deleteBankAccount,
  getWalletOverview,
  listBankAccounts,
  listWithdrawals,
} from "./service.js";

function requireTenant(req: Request): { storeId: string } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return { storeId: tenant.storeId };
}

/** GET /api/dashboard/wallet */
export async function getWalletOverviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await getWalletOverview(storeId));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/wallet/bank-accounts */
export async function listBankAccountsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json({ bankAccounts: await listBankAccounts(storeId) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/wallet/bank-accounts */
export async function createBankAccountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(201).json({ bankAccount: await createBankAccount(storeId, req.body) });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/dashboard/wallet/bank-accounts/:bankAccountId */
export async function deleteBankAccountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const bankAccountId = req.params.bankAccountId;
    if (typeof bankAccountId !== "string") {
      throw new AppError(400, "VALIDATION_ERROR", "Bank account ID is required");
    }
    await deleteBankAccount(storeId, bankAccountId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/wallet/withdrawals */
export async function createWithdrawalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(201).json({ payout: await createWithdrawal(storeId, req.body) });
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/wallet/withdrawals */
export async function listWithdrawalsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const result = await listWithdrawals(storeId, req.query);
    res.status(200).json({ withdrawals: result.items, nextCursor: result.nextCursor });
  } catch (err) {
    next(err);
  }
}
