import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { listStoreActivity } from "./service.js";

function requireTenant(req: Request): { storeId: string } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return { storeId: tenant.storeId };
}

/** GET /api/dashboard/activity */
export async function listStoreActivityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const result = await listStoreActivity(storeId, req.query);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
