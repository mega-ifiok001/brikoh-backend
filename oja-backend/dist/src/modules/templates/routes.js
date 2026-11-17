import { Router } from "express";
import { getTemplatesHandler, selectTemplateHandler, updateTemplateSettingsHandler, } from "./controller.js";
/**
 * GET /api/dashboard/templates — mounted authenticate-only in app.ts
 * (the catalog must be fetchable DURING onboarding, before the account
 * has a tenant). PUT /api/dashboard/templates and PUT
 * /api/dashboard/templates/customization — mounted on the same paths
 * with authenticate + resolveTenant + requireOwner: Express falls
 * through the first (GET-only) router to the second for PUT requests.
 */
const templatesCatalogRouter = Router();
templatesCatalogRouter.get("/", getTemplatesHandler);
const templatesSettingsRouter = Router();
templatesSettingsRouter.put("/", selectTemplateHandler);
templatesSettingsRouter.put("/customization", updateTemplateSettingsHandler);
export { templatesCatalogRouter, templatesSettingsRouter };
//# sourceMappingURL=routes.js.map