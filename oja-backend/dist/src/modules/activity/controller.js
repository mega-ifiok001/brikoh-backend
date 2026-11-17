import { AppError } from "../../lib/AppError.js";
import { listStoreActivity } from "./service.js";
function requireTenant(req) {
    const tenant = req.tenant;
    if (tenant === undefined) {
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    }
    return { storeId: tenant.storeId };
}
/** GET /api/dashboard/activity */
export async function listStoreActivityHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const result = await listStoreActivity(storeId, req.query);
        res.status(200).json(result);
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map