import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/AppError.js";
import { getPrismaClient } from "../lib/prisma.js";

/**
 * Resolves the public store from a subdomain path param — the public
 * counterpart of resolveTenant. The subdomain is the tenant's public
 * address: normalized (trimmed, lowercased) and looked up by its unique
 * DB value; anything else is a 404. Attaches req.publicStore and the
 * checkout/orders service trusts ONLY that value, never client input.
 */
export async function resolvePublicStore(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  void res;
  const raw = req.params.subdomain;
  const subdomain = typeof raw === "string" ? raw.trim().toLowerCase() : "";

  if (subdomain === "") {
    next(new AppError(400, "VALIDATION_ERROR", "Please provide a subdomain"));
    return;
  }

  const store = await getPrismaClient().store.findUnique({ where: { subdomain } });
  if (store === null) {
    next(new AppError(404, "STORE_NOT_FOUND", "No store found at that subdomain — check the URL"));
    return;
  }

  req.publicStore = {
    storeId: store.id,
    name: store.name,
    subdomain: store.subdomain,
    currency: store.currency,
  };
  next();
}
