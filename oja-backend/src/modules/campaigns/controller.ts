import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import {
  createCampaign,
  deleteCampaign,
  getCampaign,
  getCampaignStats,
  listCampaigns,
  updateCampaign,
} from "./service.js";

/**
 * Campaigns handlers (mount: /api/dashboard/campaigns — authenticate +
 * resolveTenant + authorize("marketing.manage")). Writes are
 * rate-limited at the router.
 */

function requireTenant(req: Request): { storeId: string; staffMemberId: string | undefined } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return { storeId: tenant.storeId, staffMemberId: tenant.staffMemberId };
}

function campaignIdParam(req: Request): string {
  const campaignId = req.params.campaignId;
  if (typeof campaignId !== "string" || campaignId === "") {
    throw new AppError(400, "VALIDATION_ERROR", "Campaign ID is required");
  }
  return campaignId;
}

/** GET /api/dashboard/campaigns */
export async function listCampaignsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await listCampaigns(storeId, req.query));
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/campaigns */
export async function createCampaignHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    const campaign = await createCampaign(storeId, staffMemberId, req.body);
    res.status(201).json({ campaign });
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/campaigns/stats */
export async function campaignStatsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json(await getCampaignStats(storeId));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/campaigns/:campaignId */
export async function getCampaignHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    res.status(200).json({ campaign: await getCampaign(storeId, campaignIdParam(req)) });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/dashboard/campaigns/:campaignId */
export async function updateCampaignHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    const campaign = await updateCampaign(storeId, staffMemberId, campaignIdParam(req), req.body);
    res.status(200).json({ campaign });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/dashboard/campaigns/:campaignId */
export async function deleteCampaignHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId, staffMemberId } = requireTenant(req);
    await deleteCampaign(storeId, staffMemberId, campaignIdParam(req));
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
}
