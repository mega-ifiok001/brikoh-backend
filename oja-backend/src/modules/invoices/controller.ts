import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import {
  createInvoice,
  deleteInvoice,
  getInvoiceDetail,
  getPublicInvoice,
  issueInvoice,
  listInvoices,
  recordInvoicePayment,
  setInvoiceLinkEnabled,
  updateInvoice,
  voidInvoice,
} from "./service.js";

/** Matches a well-formed UUID (v1-8). The public link id is the only credential. */
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireTenant(req: Request): { storeId: string; staffMemberId: string | undefined } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return { storeId: tenant.storeId, staffMemberId: tenant.staffMemberId };
}

function invoiceIdParam(req: Request): string {
  const invoiceId = req.params.invoiceId;
  if (typeof invoiceId !== "string" || invoiceId === "") {
    throw new AppError(400, "VALIDATION_ERROR", "Invoice ID is required");
  }
  return invoiceId;
}

/** GET /api/dashboard/invoices */
export async function listInvoicesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await listInvoices(storeId, req.query));
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/invoices */
export async function createInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res.status(201).json(await createInvoice(storeId, staffMemberId, req.body));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/invoices/:invoiceId */
export async function getInvoiceDetailHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await getInvoiceDetail(storeId, invoiceIdParam(req)));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/dashboard/invoices/:invoiceId */
export async function updateInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res
      .status(200)
      .json(await updateInvoice(storeId, staffMemberId, invoiceIdParam(req), req.body));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/dashboard/invoices/:invoiceId */
export async function deleteInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    await deleteInvoice(storeId, staffMemberId, invoiceIdParam(req));
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/invoices/:invoiceId/issue */
export async function issueInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res.status(200).json(await issueInvoice(storeId, staffMemberId, invoiceIdParam(req)));
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/invoices/:invoiceId/void */
export async function voidInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res.status(200).json(await voidInvoice(storeId, staffMemberId, invoiceIdParam(req)));
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/invoices/:invoiceId/disable-link */
export async function disableInvoiceLinkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res
      .status(200)
      .json(await setInvoiceLinkEnabled(storeId, staffMemberId, invoiceIdParam(req), false));
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/invoices/:invoiceId/enable-link */
export async function enableInvoiceLinkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res
      .status(200)
      .json(await setInvoiceLinkEnabled(storeId, staffMemberId, invoiceIdParam(req), true));
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/invoices/:invoiceId/payments */
export async function recordInvoicePaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    res
      .status(200)
      .json(await recordInvoicePayment(storeId, staffMemberId, invoiceIdParam(req), req.body));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/public/invoices/:invoiceId — no auth. The customer-facing
 * read of an invoice the merchant has shared. Read-only: the payload
 * is the public projection (items, total, amount due, and the store's
 * default account number while payable). The owner records the payment
 * on their side.
 */
export async function getPublicInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const invoiceId = invoiceIdParam(req);
    // The id is the sole credential for the public link; reject anything
    // that is not a well-formed UUID before it reaches the query layer.
    if (!UUID_REGEX.test(invoiceId)) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid invoice id");
    }
    // Never cache: while the invoice is payable the body carries a bank
    // account number that must disappear from caches the moment the
    // invoice is settled or voided.
    res.set("Cache-Control", "no-store, private");
    res.status(200).json(await getPublicInvoice(invoiceId));
  } catch (err) {
    next(err);
  }
}
