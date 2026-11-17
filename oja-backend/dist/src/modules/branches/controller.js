import { AppError } from "../../lib/AppError.js";
import { createBranch, deleteBranch, getBranch, listBranches, setDefaultBranch, transferStock, updateBranch, } from "./service.js";
function requireTenant(req) {
    const tenant = req.tenant;
    if (tenant === undefined) {
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    }
    return { storeId: tenant.storeId, staffMemberId: tenant.staffMemberId };
}
/** Express 5 types route params loosely; the routes always declare :branchId. */
function branchIdParam(req) {
    const value = req.params.branchId;
    if (typeof value !== "string" || value === "") {
        throw new AppError(400, "VALIDATION_ERROR", "Branch ID is required");
    }
    return value;
}
/** POST /api/dashboard/branches */
export async function createBranchHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        const branch = await createBranch(storeId, req.body, staffMemberId);
        res.status(201).json(branch);
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/branches */
export async function listBranchesHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await listBranches(storeId));
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/branches/:branchId */
export async function getBranchHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await getBranch(storeId, branchIdParam(req)));
    }
    catch (err) {
        next(err);
    }
}
/** PATCH /api/dashboard/branches/:branchId */
export async function updateBranchHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        res.status(200).json(await updateBranch(storeId, branchIdParam(req), req.body, staffMemberId));
    }
    catch (err) {
        next(err);
    }
}
/** PUT /api/dashboard/branches/:branchId/default */
export async function setDefaultBranchHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        res.status(200).json(await setDefaultBranch(storeId, branchIdParam(req), staffMemberId));
    }
    catch (err) {
        next(err);
    }
}
/** DELETE /api/dashboard/branches/:branchId */
export async function deleteBranchHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        res.status(200).json(await deleteBranch(storeId, branchIdParam(req), staffMemberId));
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/branches/transfers */
export async function transferStockHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        res.status(200).json(await transferStock(storeId, req.body, staffMemberId));
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map