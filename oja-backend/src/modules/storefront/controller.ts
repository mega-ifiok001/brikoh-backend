import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { getPublicStorefront, getStorefrontSettings, updateStorefrontSettings } from "./service.js";
import { getPublicProduct, listPublicProducts } from "../products/service.js";
import { listCategories } from "../catalog/categories.service.js";

function requireTenant(req: Request): { storeId: string } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return { storeId: tenant.storeId };
}

/** GET /api/dashboard/settings/storefront */
export async function getStorefrontSettingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await getStorefrontSettings(storeId));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/dashboard/settings/storefront */
export async function updateStorefrontSettingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res
      .status(200)
      .json(await updateStorefrontSettings(storeId, req.tenant?.staffMemberId, req.body));
  } catch (err) {
    next(err);
  }
}

/** GET /api/public/storefront/:subdomain */
export async function getPublicStorefrontHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const publicStore = req.publicStore;
    if (publicStore === undefined) {
      throw new AppError(404, "STORE_NOT_FOUND", "No store exists at that subdomain");
    }
    res.status(200).json(await getPublicStorefront(publicStore.storeId));
  } catch (err) {
    next(err);
  }
}

function requirePublicStore(req: Request): { storeId: string } {
  const publicStore = req.publicStore;
  if (publicStore === undefined) {
    throw new AppError(404, "STORE_NOT_FOUND", "No store exists at that subdomain");
  }
  return { storeId: publicStore.storeId };
}

/** GET /api/public/storefront/:subdomain/products */
export async function listPublicProductsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requirePublicStore(req);
    res.status(200).json(await listPublicProducts(storeId, req.query));
  } catch (err) {
    next(err);
  }
}

/** GET /api/public/storefront/:subdomain/products/:productId */
export async function getPublicProductHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requirePublicStore(req);
    const productId = typeof req.params.productId === "string" ? req.params.productId : "";
    res.status(200).json(await getPublicProduct(storeId, productId));
  } catch (err) {
    next(err);
  }
}

/** GET /api/public/storefront/:subdomain/categories */
export async function listPublicCategoriesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requirePublicStore(req);
    const categories = await listCategories(storeId);
    res.status(200).json(categories.map((category) => ({ id: category.id, name: category.name })));
  } catch (err) {
    next(err);
  }
}
