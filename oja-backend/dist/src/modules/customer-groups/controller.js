import { AppError } from "../../lib/AppError.js";
import { createCustomerGroup, deleteCustomerGroup, getCustomerGroup, listCustomerGroups, updateCustomerGroup, } from "./service.js";
function requireTenant(req) {
    const tenant = req.tenant;
    if (tenant === undefined) {
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    }
    return { storeId: tenant.storeId, staffMemberId: tenant.staffMemberId };
}
function groupIdParam(req) {
    const groupId = req.params.groupId;
    if (typeof groupId !== "string" || groupId === "") {
        throw new AppError(400, "VALIDATION_ERROR", "Customer group ID is required");
    }
    return groupId;
}
/** GET /api/dashboard/customer-groups */
export async function listCustomerGroupsHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json({ items: await listCustomerGroups(storeId) });
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/customer-groups */
export async function createCustomerGroupHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        res.status(201).json(await createCustomerGroup(storeId, staffMemberId, req.body));
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/customer-groups/:groupId */
export async function getCustomerGroupHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await getCustomerGroup(storeId, groupIdParam(req)));
    }
    catch (err) {
        next(err);
    }
}
/** PUT /api/dashboard/customer-groups/:groupId */
export async function updateCustomerGroupHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        res
            .status(200)
            .json(await updateCustomerGroup(storeId, staffMemberId, groupIdParam(req), req.body));
    }
    catch (err) {
        next(err);
    }
}
/** DELETE /api/dashboard/customer-groups/:groupId */
export async function deleteCustomerGroupHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        await deleteCustomerGroup(storeId, staffMemberId, groupIdParam(req));
        res.status(200).json({ ok: true });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map