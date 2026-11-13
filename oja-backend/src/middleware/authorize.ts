import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/AppError.js";

/**
 * Route guard factory. Owners pass every permission check; staff pass
 * only when their resolved tenant permissions include the required one.
 * Must be mounted after authenticate and resolveTenant on the same
 * stack — it reads req.tenant.
 */
export function authorize(requiredPermission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void res;
    const tenant = req.tenant;
    if (tenant === undefined) {
      next(new AppError(401, "NEED_LOGIN", "Please log in to continue"));
      return;
    }
    if (tenant.role === "OWNER" || tenant.permissions.includes(requiredPermission)) {
      next();
      return;
    }
    next(
      new AppError(
        403,
        "ACCESS_DENIED",
        `You don't have permission to ${requiredPermission.replace(".", " ")}`,
      ),
    );
  };
}
