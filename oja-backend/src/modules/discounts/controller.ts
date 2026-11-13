import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import {
  createDiscount,
  deleteDiscount,
  getDiscount,
  listDiscounts,
  updateDiscount,
} from "./service.js";

function requireTenant(req: Request): { storeId: string; staffMemberId: string | undefined } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return { storeId: tenant.storeId, staffMemberId: tenant.staffMemberId };
}

function discountIdParam(req: Request): string {
  const discountId = req.params.discountId;
  if (typeof discountId !== "string" || discountId === "") {
    throw new AppError(400, "VALIDATION_ERROR", "Discount ID is required");
  }
  return discountId;
}

/** GET /api/dashboard/discounts */
export async function listDiscountsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await listDiscounts(storeId, req.query));
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/discounts */
export async function createDiscountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res.status(201).json(await createDiscount(storeId, staffMemberId, req.body));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/discounts/:discountId */
export async function getDiscountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await getDiscount(storeId, discountIdParam(req)));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/dashboard/discounts/:discountId */
export async function updateDiscountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res
      .status(200)
      .json(await updateDiscount(storeId, staffMemberId, discountIdParam(req), req.body));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/dashboard/discounts/:discountId */
export async function deleteDiscountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    await deleteDiscount(storeId, staffMemberId, discountIdParam(req));
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
}
