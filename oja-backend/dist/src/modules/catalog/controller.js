import { AppError } from "../../lib/AppError.js";
import { createCategory, deleteCategory, getCategory, listCategories, updateCategory, } from "./categories.service.js";
import { createUnit, deleteUnit, getUnit, listUnits, updateUnit } from "./units.service.js";
function requireTenant(req) {
    const tenant = req.tenant;
    if (tenant === undefined) {
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    }
    return { storeId: tenant.storeId, staffMemberId: tenant.staffMemberId };
}
/** Express 5 types route params loosely; the routes always declare :categoryId. */
function categoryIdParam(req) {
    const value = req.params.categoryId;
    if (typeof value !== "string" || value === "") {
        throw new AppError(400, "VALIDATION_ERROR", "Category ID is required");
    }
    return value;
}
function unitIdParam(req) {
    const value = req.params.unitId;
    if (typeof value !== "string" || value === "") {
        throw new AppError(400, "VALIDATION_ERROR", "Unit ID is required");
    }
    return value;
}
/** POST /api/dashboard/categories */
export async function createCategoryHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const category = await createCategory(storeId, req.body);
        res.status(201).json(category);
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/categories */
export async function listCategoriesHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await listCategories(storeId));
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/categories/:categoryId */
export async function getCategoryHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const category = await getCategory(storeId, categoryIdParam(req));
        res.status(200).json(category);
    }
    catch (err) {
        next(err);
    }
}
/** PATCH /api/dashboard/categories/:categoryId */
export async function updateCategoryHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const category = await updateCategory(storeId, categoryIdParam(req), req.body);
        res.status(200).json(category);
    }
    catch (err) {
        next(err);
    }
}
/** DELETE /api/dashboard/categories/:categoryId */
export async function deleteCategoryHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        await deleteCategory(storeId, categoryIdParam(req));
        res.status(204).send();
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/units */
export async function createUnitHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const unit = await createUnit(storeId, req.body);
        res.status(201).json(unit);
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/units */
export async function listUnitsHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await listUnits(storeId));
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/units/:unitId */
export async function getUnitHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const unit = await getUnit(storeId, unitIdParam(req));
        res.status(200).json(unit);
    }
    catch (err) {
        next(err);
    }
}
/** PATCH /api/dashboard/units/:unitId */
export async function updateUnitHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const unit = await updateUnit(storeId, unitIdParam(req), req.body);
        res.status(200).json(unit);
    }
    catch (err) {
        next(err);
    }
}
/** DELETE /api/dashboard/units/:unitId */
export async function deleteUnitHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        await deleteUnit(storeId, unitIdParam(req));
        res.status(204).send();
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map