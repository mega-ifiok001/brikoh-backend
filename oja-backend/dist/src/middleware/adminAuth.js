import { AppError } from "../lib/AppError.js";
import { verifyAdminAccessToken } from "../lib/adminTokens.js";
import { AdminService } from "../modules/admin/service.js";
/**
 * Admin trust boundary (mount at /api/admin): verifies the ADMIN JWT
 * (distinct secret from merchant tokens — see lib/adminTokens.ts), loads
 * the admin's CURRENT role + permission keys from the database, and
 * attaches req.admin. Never merchant middleware: resolveTenant does NOT
 * apply to admin routes, and cross-store actions are audit-logged instead
 * of scoped.
 */
export function requireAdminAuth(req, res, next) {
    void res;
    const header = req.header("authorization");
    if (header === undefined || !header.startsWith("Bearer ")) {
        next(new AppError(401, "NEED_LOGIN", "Please log in to continue"));
        return;
    }
    const token = header.slice("Bearer ".length).trim();
    if (token === "") {
        next(new AppError(401, "NEED_LOGIN", "Please log in to continue"));
        return;
    }
    try {
        const payload = verifyAdminAccessToken(token);
        const service = new AdminService();
        service
            .getAuthContext(payload.sub)
            .then((context) => {
            if (!context.isActive) {
                next(new AppError(403, "ACCOUNT_DISABLED", "This admin account has been deactivated"));
                return;
            }
            req.admin = {
                adminUserId: context.adminUserId,
                email: context.email,
                roleName: context.roleName,
                permissions: context.permissions,
            };
            next();
        })
            .catch((err) => next(err));
    }
    catch (err) {
        next(err);
    }
}
/**
 * Route guard factory for admin permission keys. SUPER_ADMIN passes every
 * check implicitly (mirroring merchant owners); every other role must
 * hold the key in its CURRENT RolePermission bindings. The key set is
 * data — a brand-new Permission row + binding grants it with zero schema
 * changes.
 */
export function requireAdminPermission(requiredKey) {
    return (req, res, next) => {
        void res;
        const admin = req.admin;
        if (admin === undefined) {
            next(new AppError(401, "NEED_LOGIN", "Please log in to continue"));
            return;
        }
        if (admin.roleName === "SUPER_ADMIN" || admin.permissions.includes(requiredKey)) {
            next();
            return;
        }
        next(new AppError(403, "ACCESS_DENIED", `You don't have permission to ${requiredKey.replace(".", " ")}`));
    };
}
//# sourceMappingURL=adminAuth.js.map