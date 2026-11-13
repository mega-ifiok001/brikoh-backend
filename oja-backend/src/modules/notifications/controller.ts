import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { defaultAlertSender } from "./email.js";
import { listDispatches, sendTestAlert } from "./service.js";

function requireTenant(req: Request): { storeId: string } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return { storeId: tenant.storeId };
}

/** GET /api/dashboard/notifications */
export async function listNotificationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const page = await listDispatches(storeId, {
      limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
    });
    res.status(200).json(page);
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/notifications/test */
export async function sendTestAlertHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await sendTestAlert(defaultAlertSender(), storeId));
  } catch (err) {
    next(err);
  }
}
