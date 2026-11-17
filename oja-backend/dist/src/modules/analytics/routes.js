import { Router } from "express";
import { channelsHandler, staffPerformanceHandler, summaryHandler, timeseriesHandler, trendsHandler, } from "./controller.js";
/**
 * Dashboard analytics. The group mount in app.ts carries
 * authenticate + resolveTenant + authorize("analytics.manage");
 * tier gating for advanced endpoints happens in the service.
 */
export const analyticsRouter = Router();
analyticsRouter.get("/summary", summaryHandler);
analyticsRouter.get("/timeseries", timeseriesHandler);
analyticsRouter.get("/trends", trendsHandler);
analyticsRouter.get("/staff-performance", staffPerformanceHandler);
analyticsRouter.get("/channels", channelsHandler);
//# sourceMappingURL=routes.js.map