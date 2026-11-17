import { AppError } from "../../lib/AppError.js";
import { getPaymentProviderSettings, getSettlementStatuses, setPaymentProviderSettings, } from "./service.js";
function requireTenant(req) {
    const tenant = req.tenant;
    if (tenant === undefined) {
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    }
    return { storeId: tenant.storeId };
}
/** GET /api/dashboard/payments/provider */
export async function getPaymentProviderSettingsHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await getPaymentProviderSettings(storeId));
    }
    catch (err) {
        next(err);
    }
}
/** PUT /api/dashboard/payments/provider */
export async function setPaymentProviderSettingsHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await setPaymentProviderSettings(storeId, req.body));
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/payments/settlements */
export async function getSettlementStatusesHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json({ settlements: await getSettlementStatuses(storeId) });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map