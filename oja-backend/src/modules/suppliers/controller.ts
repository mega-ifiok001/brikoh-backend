import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import {
  createSupplier,
  deleteSupplier,
  getSupplier,
  listSuppliers,
  updateSupplier,
} from "./service.js";

function requireTenant(req: Request): { storeId: string } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return { storeId: tenant.storeId };
}

function supplierIdParam(req: Request): string {
  const supplierId = req.params.supplierId;
  if (typeof supplierId !== "string" || supplierId === "") {
    throw new AppError(400, "VALIDATION_ERROR", "Supplier ID is required");
  }
  return supplierId;
}

/** POST /api/dashboard/suppliers */
export async function createSupplierHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(201).json(await createSupplier(storeId, req.tenant?.staffMemberId, req.body));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/suppliers */
export async function listSuppliersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json({ items: await listSuppliers(storeId) });
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/suppliers/:supplierId */
export async function getSupplierHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await getSupplier(storeId, supplierIdParam(req)));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/dashboard/suppliers/:supplierId */
export async function updateSupplierHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res
      .status(200)
      .json(
        await updateSupplier(storeId, supplierIdParam(req), req.tenant?.staffMemberId, req.body),
      );
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/dashboard/suppliers/:supplierId */
export async function deleteSupplierHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    await deleteSupplier(storeId, supplierIdParam(req), req.tenant?.staffMemberId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
