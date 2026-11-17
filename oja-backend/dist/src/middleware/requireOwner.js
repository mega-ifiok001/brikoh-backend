import { AppError } from "../lib/AppError.js";
/**
 * Tenant-root guard: only the store OWNER passes. Staff members are
 * rejected with 403 ACCESS_DENIED regardless of their role or
 * permission flags (staff.manage included) — staff management is a
 * tenant-root privilege, not a feature-level one. Must be mounted after
 * authenticate and resolveTenant on the same stack — it reads req.tenant.
 */
export function requireOwner(req, res, next) {
    void res;
    const tenant = req.tenant;
    if (tenant === undefined) {
        next(new AppError(401, "NEED_LOGIN", "Please log in to continue"));
        return;
    }
    if (tenant.role !== "OWNER") {
        next(new AppError(403, "ACCESS_DENIED", "Only the store owner can perform this action"));
        return;
    }
    next();
}
//# sourceMappingURL=requireOwner.js.map