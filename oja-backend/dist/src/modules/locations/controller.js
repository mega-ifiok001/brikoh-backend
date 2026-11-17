import { AppError } from "../../lib/AppError.js";
import { createLocation, listLocations } from "./service.js";
function requireTenant(req) {
    const tenant = req.tenant;
    if (tenant === undefined) {
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    }
    return { storeId: tenant.storeId };
}
/** POST /api/dashboard/locations */
export async function createLocationHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const location = await createLocation(storeId, req.body);
        res.status(201).json(location);
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/locations */
export async function listLocationsHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await listLocations(storeId));
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map