import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import {
  createCustomerGroup,
  deleteCustomerGroup,
  getCustomerGroup,
  listCustomerGroups,
  updateCustomerGroup,
} from "./service.js";

function requireTenant(req: Request): { storeId: string; staffMemberId: string | undefined } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return { storeId: tenant.storeId, staffMemberId: tenant.staffMemberId };
}

function groupIdParam(req: Request): string {
  const groupId = req.params.groupId;
  if (typeof groupId !== "string" || groupId === "") {
    throw new AppError(400, "VALIDATION_ERROR", "Customer group ID is required");
  }
  return groupId;
}

/** GET /api/dashboard/customer-groups */
export async function listCustomerGroupsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json({ items: await listCustomerGroups(storeId) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/customer-groups */
export async function createCustomerGroupHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res.status(201).json(await createCustomerGroup(storeId, staffMemberId, req.body));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/customer-groups/:groupId */
export async function getCustomerGroupHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await getCustomerGroup(storeId, groupIdParam(req)));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/dashboard/customer-groups/:groupId */
export async function updateCustomerGroupHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res
      .status(200)
      .json(await updateCustomerGroup(storeId, staffMemberId, groupIdParam(req), req.body));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/dashboard/customer-groups/:groupId */
export async function deleteCustomerGroupHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    await deleteCustomerGroup(storeId, staffMemberId, groupIdParam(req));
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
}
