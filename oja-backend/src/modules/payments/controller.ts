import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import {
  getPaymentProviderSettings,
  getSettlementStatuses,
  setPaymentProviderSettings,
} from "./service.js";

function requireTenant(req: Request): { storeId: string } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return { storeId: tenant.storeId };
}

/** GET /api/dashboard/payments/provider */
export async function getPaymentProviderSettingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await getPaymentProviderSettings(storeId));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/dashboard/payments/provider */
export async function setPaymentProviderSettingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await setPaymentProviderSettings(storeId, req.body));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/payments/settlements */
export async function getSettlementStatusesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json({ settlements: await getSettlementStatuses(storeId) });
  } catch (err) {
    next(err);
  }
}
