import { AppError } from "../lib/AppError.js";
import { PERMISSIONS } from "../lib/permissions.js";
import { getPrismaClient } from "../lib/prisma.js";
/**
 * Resolves the request's tenant from the database: the account's Owner
 * membership wins over StaffMember, and the owner always holds the full
 * permission set. Attaches req.tenant = { storeId, role, staffMemberId,
 * permissions }. The storeId comes exclusively from the membership
 * records — a token's storeId claim or any client-supplied value is
 * never trusted — so a manipulated request cannot resolve to another
 * tenant's context.
 */
export async function resolveTenant(req, res, next) {
    void res;
    const account = req.account;
    if (account === undefined) {
        next(new AppError(401, "NEED_LOGIN", "Please log in to continue"));
        return;
    }
    const dbAccount = await getPrismaClient().account.findUnique({
        where: { id: account.accountId },
        include: {
            owner: { include: { store: true } },
            staffMembers: { include: { store: true } },
        },
    });
    if (dbAccount === null) {
        next(new AppError(401, "ACCOUNT_MISSING", "Your account no longer exists — please contact support"));
        return;
    }
    const owner = dbAccount.owner;
    const staffMember = dbAccount.staffMembers[0];
    if (owner === null && staffMember === undefined) {
        next(new AppError(403, "ONBOARDING_REQUIRED", "You need to complete store setup first"));
        return;
    }
    // A deactivated staff member (their only membership) is denied at the
    // middleware — even a pre-deactivation access token dies here.
    if (owner === null && staffMember !== undefined && !staffMember.isActive) {
        next(new AppError(403, "ACCOUNT_DISABLED", "This account has been deactivated — contact your store owner"));
        return;
    }
    // The "all" wildcard grants the full permission set, exactly like an
    // owner (authorize is bypassed for owners on role; staff need the
    // flags — expanding here covers every route uniformly).
    const staffPermissions = staffMember?.permissions ?? [];
    const permissions = owner !== null || staffPermissions.includes("all") ? [...PERMISSIONS] : staffPermissions;
    req.tenant = owner
        ? {
            storeId: owner.storeId,
            role: "OWNER",
            staffMemberId: undefined,
            permissions,
        }
        : {
            storeId: staffMember.storeId,
            role: staffMember.role,
            staffMemberId: staffMember.id,
            permissions,
        };
    next();
}
//# sourceMappingURL=resolveTenant.js.map