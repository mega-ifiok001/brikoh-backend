import { Router } from "express";
import { resolvePublicStore } from "../../middleware/resolvePublicStore.js";
import { getPublicStorefrontHandler, getStorefrontSettingsHandler, getPublicProductHandler, listPublicCategoriesHandler, listPublicProductsHandler, updateStorefrontSettingsHandler, } from "./controller.js";
/**
 * Owner-only dashboard surface (mount: /api/dashboard/settings/storefront
 * — authenticate + resolveTenant + requireOwner + rate limit, the same
 * trust stack as the settings group).
 */
const storefrontSettingsRouter = Router();
storefrontSettingsRouter.get("/", getStorefrontSettingsHandler);
storefrontSettingsRouter.put("/", updateStorefrontSettingsHandler);
/**
 * Public storefront read (mount: /api/public/storefront, rate-limited).
 * The subdomain is the tenant's public address; resolvePublicStore
 * rejects unknown subdomains before the handler runs.
 */
const storefrontPublicRouter = Router();
storefrontPublicRouter.get("/:subdomain", resolvePublicStore, getPublicStorefrontHandler);
storefrontPublicRouter.get("/:subdomain/products", resolvePublicStore, listPublicProductsHandler);
storefrontPublicRouter.get("/:subdomain/products/:productId", resolvePublicStore, getPublicProductHandler);
storefrontPublicRouter.get("/:subdomain/categories", resolvePublicStore, listPublicCategoriesHandler);
export { storefrontPublicRouter, storefrontSettingsRouter };
//# sourceMappingURL=routes.js.map