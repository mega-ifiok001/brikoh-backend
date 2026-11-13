import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { selectTemplateSchema, templateSettingsSchema, validateOrThrow } from "./schemas.js";
import { getTemplateCatalog, selectStoreTemplate, setStoreTemplateSettings } from "./service.js";

/** GET /api/dashboard/templates — authenticate only (works pre-onboarding). */
export async function getTemplatesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const account = req.account;
  if (account === undefined) {
    next(new AppError(401, "UNAUTHORIZED", "Authentication required"));
    return;
  }
  try {
    res.status(200).json(await getTemplateCatalog(account.accountId));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/dashboard/templates — owner-only (requireOwner mounted in app.ts). */
export async function selectTemplateHandler(
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
    const data = validateOrThrow(selectTemplateSchema, req.body);
    res.status(200).json(await selectStoreTemplate(tenant.storeId, data.templateId));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/dashboard/templates/customization — owner-only (requireOwner mounted in app.ts). */
export async function updateTemplateSettingsHandler(
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
    const data = validateOrThrow(templateSettingsSchema, req.body);
    res.status(200).json(await setStoreTemplateSettings(tenant.storeId, data));
  } catch (err) {
    next(err);
  }
}
