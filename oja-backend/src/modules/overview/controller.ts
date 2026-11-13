import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { getOverview } from "./service.js";

function requireTenant(req: Request): { storeId: string; canViewRevenue: boolean } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return {
    storeId: tenant.storeId,
    // Owners implicitly hold every permission (resolveTenant grants the
    // full set); staff must be granted viewProfit in the staff form.
    canViewRevenue: tenant.permissions.includes("viewProfit"),
  };
}

/** GET /api/dashboard/overview */
export async function getOverviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, canViewRevenue } = requireTenant(req);
    res.status(200).json(await getOverview(storeId, canViewRevenue));
  } catch (err) {
    next(err);
  }
}
