import { Router } from "express";
import { rateLimit } from "../../middleware/rateLimit.js";
import {
  createInvoiceHandler,
  deleteInvoiceHandler,
  disableInvoiceLinkHandler,
  enableInvoiceLinkHandler,
  getInvoiceDetailHandler,
  getPublicInvoiceHandler,
  issueInvoiceHandler,
  listInvoicesHandler,
  recordInvoicePaymentHandler,
  updateInvoiceHandler,
  voidInvoiceHandler,
} from "./controller.js";

/**
 * Invoices (mount: /api/dashboard/invoices — authenticate +
 * resolveTenant + authorize("invoices.manage")). Writes and the
 * money-touching payment route get the payments baseline limiter
 * (60/min) like the POS record-sale route. Route order matters: the
 * fixed "issue", "void", and "payments" segments are declared BEFORE
 * the ":invoiceId" wildcard so they are never swallowed as an id.
 */
const invoicesRouter: Router = Router();
invoicesRouter.post(
  "/:invoiceId/issue",
  rateLimit({ windowMs: 60_000, max: 60 }),
  issueInvoiceHandler,
);
invoicesRouter.post(
  "/:invoiceId/void",
  rateLimit({ windowMs: 60_000, max: 60 }),
  voidInvoiceHandler,
);
invoicesRouter.post(
  "/:invoiceId/payments",
  rateLimit({ windowMs: 60_000, max: 60 }),
  recordInvoicePaymentHandler,
);
invoicesRouter.post(
  "/:invoiceId/disable-link",
  rateLimit({ windowMs: 60_000, max: 60 }),
  disableInvoiceLinkHandler,
);
invoicesRouter.post(
  "/:invoiceId/enable-link",
  rateLimit({ windowMs: 60_000, max: 60 }),
  enableInvoiceLinkHandler,
);
invoicesRouter.get("/", listInvoicesHandler);
invoicesRouter.post("/", rateLimit({ windowMs: 60_000, max: 60 }), createInvoiceHandler);
invoicesRouter.get("/:invoiceId", getInvoiceDetailHandler);
invoicesRouter.put("/:invoiceId", rateLimit({ windowMs: 60_000, max: 60 }), updateInvoiceHandler);
invoicesRouter.delete(
  "/:invoiceId",
  rateLimit({ windowMs: 60_000, max: 60 }),
  deleteInvoiceHandler,
);

/**
 * Public invoice link (mount: /api/public/invoices — no auth). Read-only
 * projection for the customer holding the shared link; the invoice id is
 * the only credential. The link never expires — a paid or voided invoice
 * still renders, just not payable. Rate-limited to blunt link-harvesting:
 * 30/min per IP keeps legitimate refreshes flowing while making UUID
 * enumeration impractical.
 */
const publicInvoicesRouter: Router = Router();
publicInvoicesRouter.get(
  "/:invoiceId",
  rateLimit({ windowMs: 60_000, max: 30 }),
  getPublicInvoiceHandler,
);

export { invoicesRouter, publicInvoicesRouter };
