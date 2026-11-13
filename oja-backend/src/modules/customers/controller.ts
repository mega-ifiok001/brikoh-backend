import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import {
  createCustomer,
  deleteCustomer,
  exportCustomers,
  getCustomerDetail,
  importCustomers,
  listCustomers,
  recordCreditRepayment,
  updateCustomer,
} from "./service.js";

function requireTenant(req: Request): { storeId: string; staffMemberId: string | undefined } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return { storeId: tenant.storeId, staffMemberId: tenant.staffMemberId };
}

function customerIdParam(req: Request): string {
  const customerId = req.params.customerId;
  if (typeof customerId !== "string" || customerId === "") {
    throw new AppError(400, "VALIDATION_ERROR", "Customer ID is required");
  }
  return customerId;
}

/** GET /api/dashboard/customers */
export async function listCustomersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await listCustomers(storeId, req.query));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/customers/export.csv */
export async function exportCustomersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const csv = await exportCustomers(storeId);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="customers.csv"');
    res.status(200).send(csv);
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/customers/import — raw CSV body (text/csv). */
export async function importCustomersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res.status(201).json(await importCustomers(storeId, staffMemberId, req.body));
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/customers */
export async function createCustomerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res.status(201).json(await createCustomer(storeId, staffMemberId, req.body));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/customers/:customerId */
export async function getCustomerDetailHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await getCustomerDetail(storeId, customerIdParam(req)));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/dashboard/customers/:customerId */
export async function updateCustomerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res
      .status(200)
      .json(await updateCustomer(storeId, staffMemberId, customerIdParam(req), req.body));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/dashboard/customers/:customerId */
export async function deleteCustomerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    await deleteCustomer(storeId, staffMemberId, customerIdParam(req));
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/customers/:customerId/credits/repayments */
export async function recordCreditRepaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res
      .status(200)
      .json(await recordCreditRepayment(storeId, staffMemberId, customerIdParam(req), req.body));
  } catch (err) {
    next(err);
  }
}
