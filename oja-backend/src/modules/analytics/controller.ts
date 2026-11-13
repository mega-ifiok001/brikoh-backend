import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { parseAnalyticsQuery } from "./schemas.js";
import { AnalyticsService } from "./service.js";

const analytics = new AnalyticsService();

function requireTenant(req: Request): { storeId: string } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return { storeId: tenant.storeId };
}

/** GET /api/dashboard/analytics/summary */
export async function summaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const range = parseAnalyticsQuery(req.query);
    res.status(200).json(await analytics.getSalesSummary(storeId, range, range.top));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/analytics/timeseries */
export async function timeseriesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const range = parseAnalyticsQuery(req.query);
    res.status(200).json(await analytics.getTimeseries(storeId, range, range.granularity));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/analytics/trends */
export async function trendsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const range = parseAnalyticsQuery(req.query);
    res.status(200).json(await analytics.getSalesTrends(storeId, range, range.granularity));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/analytics/staff-performance */
export async function staffPerformanceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const range = parseAnalyticsQuery(req.query);
    res.status(200).json(await analytics.getStaffPerformance(storeId, range));
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/analytics/channels */
export async function channelsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const range = parseAnalyticsQuery(req.query);
    res.status(200).json(await analytics.getChannels(storeId, range));
  } catch (err) {
    next(err);
  }
}
