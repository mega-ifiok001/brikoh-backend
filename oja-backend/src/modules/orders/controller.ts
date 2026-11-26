import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import {
  confirmBankTransferPayment,
  getOrderDetail,
  getPublicOrder,
  initiateCheckout,
  listOrders,
  markBankTransferPaid,
  rejectBankTransferPayment,
} from "./service.js";
import { recordPosSale } from "./pos.service.js";
import { getFulfillment, updateFulfillment } from "./fulfillment.service.js";
import { confirmBankTransferSchema, listOrdersParamsSchema, validateOrThrow } from "./schemas.js";

/** POST /api/public/checkout/:subdomain */
export async function checkoutHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const store = req.publicStore;
    if (store === undefined) {
      throw new AppError(404, "STORE_NOT_FOUND", "No store exists at that subdomain");
    }
    res
      .status(200)
      .json(await initiateCheckout(store.storeId, req.body, undefined, store.currency));
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/orders — record a POS sale (orders.manage, owner implicit). */
export async function recordPosSaleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tenant = req.tenant;
  if (tenant === undefined) {
    next(new AppError(401, "UNAUTHORIZED", "Authentication required"));
    return;
  }
  try {
    res.status(201).json(await recordPosSale(tenant.storeId, tenant.staffMemberId, req.body));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/orders — paginated order list. */
export async function listOrdersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tenant = req.tenant;
  if (tenant === undefined) {
    next(new AppError(401, "UNAUTHORIZED", "Authentication required"));
    return;
  }
  try {
    const params = validateOrThrow(listOrdersParamsSchema, req.query);
    res.status(200).json(await listOrders(tenant.storeId, params));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/orders/:orderId — one order with line items. */
export async function getOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tenant = req.tenant;
  if (tenant === undefined) {
    next(new AppError(401, "UNAUTHORIZED", "Authentication required"));
    return;
  }
  try {
    res.status(200).json(await getOrderDetail(tenant.storeId, String(req.params.orderId)));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/orders/:orderId/fulfillment */
export async function getFulfillmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenant = req.tenant;
    if (tenant === undefined) throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    res.status(200).json(await getFulfillment(tenant.storeId, String(req.params.orderId)));
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/dashboard/orders/:orderId/fulfillment */
export async function updateFulfillmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenant = req.tenant;
    if (tenant === undefined) throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    res.status(200).json(
      await updateFulfillment(
        tenant.storeId,
        String(req.params.orderId),
        tenant.staffMemberId,
        req.body,
        req.header("Idempotency-Key"),
      ),
    );
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/orders/:orderId/confirm-payment — confirm a claimed bank transfer. */
export async function confirmPaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tenant = req.tenant;
  if (tenant === undefined) {
    next(new AppError(401, "UNAUTHORIZED", "Authentication required"));
    return;
  }
  try {
    const parsed = validateOrThrow(confirmBankTransferSchema, req.body ?? {});
    res
      .status(200)
      .json(
        await confirmBankTransferPayment(
          tenant.storeId,
          String(req.params.orderId),
          parsed.confirmedAmount,
        ),
      );
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/orders/:orderId/reject-payment — reject a claimed bank transfer. */
export async function rejectPaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tenant = req.tenant;
  if (tenant === undefined) {
    next(new AppError(401, "UNAUTHORIZED", "Authentication required"));
    return;
  }
  try {
    res
      .status(200)
      .json(await rejectBankTransferPayment(tenant.storeId, String(req.params.orderId)));
  } catch (err) {
    next(err);
  }
}

/** GET /api/public/orders/:orderId — public order status + frozen bank details. */
export async function getPublicOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.status(200).json(await getPublicOrder(String(req.params.orderId)));
  } catch (err) {
    next(err);
  }
}

/** POST /api/public/orders/:orderId/mark-paid — customer "I have paid". */
export async function markPaidHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.status(200).json(await markBankTransferPaid(String(req.params.orderId)));
  } catch (err) {
    next(err);
  }
}
