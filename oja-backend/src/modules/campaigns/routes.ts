import { Router } from "express";
import { rateLimit } from "../../middleware/rateLimit.js";
import {
  campaignStatsHandler,
  createCampaignHandler,
  deleteCampaignHandler,
  getCampaignHandler,
  listCampaignsHandler,
  updateCampaignHandler,
} from "./controller.js";

/**
 * Campaigns (mount: /api/dashboard/campaigns — authenticate +
 * resolveTenant + authorize("marketing.manage")). Writes get the
 * payments baseline limiter (60/min); campaigns drive what the public
 * storefront shows, so they are money-adjacent like the other tenant
 * resources.
 */
const campaignsRouter: Router = Router();
campaignsRouter.get("/", listCampaignsHandler);
// Static before parametric: /stats must not be swallowed by /:campaignId.
campaignsRouter.get("/stats", campaignStatsHandler);
campaignsRouter.post("/", rateLimit({ windowMs: 60_000, max: 60 }), createCampaignHandler);
campaignsRouter.get("/:campaignId", getCampaignHandler);
campaignsRouter.put(
  "/:campaignId",
  rateLimit({ windowMs: 60_000, max: 60 }),
  updateCampaignHandler,
);
campaignsRouter.delete(
  "/:campaignId",
  rateLimit({ windowMs: 60_000, max: 60 }),
  deleteCampaignHandler,
);

export { campaignsRouter };
