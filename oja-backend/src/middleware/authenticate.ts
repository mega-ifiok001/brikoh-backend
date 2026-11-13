import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/AppError.js";
import { verifyAccessToken } from "../lib/tokens.js";

/**
 * Verifies the bearer JWT (signature + expiry) and attaches the decoded
 * account to req.account. Distinguishes missing token (NEED_LOGIN) from
 * expired (SESSION_EXPIRED) or invalid (INVALID_TOKEN) tokens.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  void res;
  const header = req.header("authorization");
  if (header === undefined || !header.startsWith("Bearer ")) {
    next(new AppError(401, "NEED_LOGIN", "Please log in to continue"));
    return;
  }
  const token = header.slice("Bearer ".length).trim();
  if (token === "") {
    next(new AppError(401, "NEED_LOGIN", "Please log in to continue"));
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.account = {
      accountId: payload.sub,
      storeId: payload.storeId,
      role: payload.role,
      staffMemberId: payload.staffMemberId,
    };
    next();
  } catch (err) {
    next(err);
  }
}
