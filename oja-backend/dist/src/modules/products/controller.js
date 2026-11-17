import { AppError } from "../../lib/AppError.js";
import { validateOrThrow } from "../../lib/validate.js";
import { confirmBulkImport, startBulkImport } from "./bulk.service.js";
import { recordStockChange } from "./ledger.service.js";
import { addProductVariant, archiveProductVariant, createProduct, getProduct, listProducts, publishProduct, restoreProductVariant, setProductOptions, softDeleteProduct, unpublishProduct, updateProduct, updateProductVariant, } from "./service.js";
import { stockAdjustmentSchema } from "./schemas.js";
function requireTenant(req) {
    const tenant = req.tenant;
    if (tenant === undefined) {
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    }
    return { storeId: tenant.storeId, staffMemberId: tenant.staffMemberId };
}
/** Express 5 types route params loosely; the routes always declare :productId. */
function productIdParam(req) {
    const value = req.params.productId;
    if (typeof value !== "string" || value === "") {
        throw new AppError(400, "VALIDATION_ERROR", "Product ID is required");
    }
    return value;
}
/** POST /api/dashboard/products */
export async function createProductHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        const product = await createProduct(storeId, req.body, staffMemberId);
        res.status(201).json(product);
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/products */
export async function listProductsHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const result = await listProducts(storeId, req.query);
        res.status(200).json(result);
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/products/:productId */
export async function getProductHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        const product = await getProduct(storeId, productIdParam(req));
        res.status(200).json(product);
    }
    catch (err) {
        next(err);
    }
}
/** PATCH /api/dashboard/products/:productId */
export async function updateProductHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        const product = await updateProduct(storeId, productIdParam(req), req.body, staffMemberId);
        res.status(200).json(product);
    }
    catch (err) {
        next(err);
    }
}
/** DELETE /api/dashboard/products/:productId */
export async function softDeleteProductHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        await softDeleteProduct(storeId, productIdParam(req), staffMemberId);
        res.status(204).send();
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/products/:productId/publish */
export async function publishProductHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        const product = await publishProduct(storeId, productIdParam(req), staffMemberId);
        res.status(200).json(product);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/products/:productId/unpublish */
export async function unpublishProductHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        const product = await unpublishProduct(storeId, productIdParam(req), staffMemberId);
        res.status(200).json(product);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/products/bulk/import */
export async function startBulkImportHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        const result = await startBulkImport(storeId, staffMemberId, req.body);
        res.status(200).json(result);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/products/bulk/confirm */
export async function confirmBulkImportHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        const result = await confirmBulkImport(storeId, staffMemberId, req.body);
        res.status(200).json(result);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/products/:productId/stock-adjustments */
export async function adjustStockHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        const body = validateOrThrow(stockAdjustmentSchema, req.body);
        const result = await recordStockChange({
            storeId,
            branchId: body.branchId,
            productId: productIdParam(req),
            variantId: body.variantId,
            quantityChange: body.quantityChange,
            reason: body.reason,
            referenceId: body.referenceId,
            performedByStaffId: staffMemberId,
        });
        res.status(200).json(result);
    }
    catch (err) {
        next(err);
    }
}
/** Express 5 types route params loosely; the routes declare :variantId. */
function variantIdParam(req) {
    const value = req.params.variantId;
    if (typeof value !== "string" || value === "") {
        throw new AppError(400, "VALIDATION_ERROR", "Variant ID is required");
    }
    return value;
}
/** PUT /api/dashboard/products/:productId/options */
export async function setProductOptionsHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        const product = await setProductOptions(storeId, productIdParam(req), req.body, staffMemberId);
        res.status(200).json(product);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/products/:productId/variants */
export async function addVariantHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        const product = await addProductVariant(storeId, productIdParam(req), req.body, staffMemberId);
        res.status(201).json(product);
    }
    catch (err) {
        next(err);
    }
}
/** PATCH /api/dashboard/products/:productId/variants/:variantId */
export async function updateVariantHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        const product = await updateProductVariant(storeId, productIdParam(req), variantIdParam(req), req.body, staffMemberId);
        res.status(200).json(product);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/products/:productId/variants/:variantId/archive */
export async function archiveVariantHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        const product = await archiveProductVariant(storeId, productIdParam(req), variantIdParam(req), staffMemberId);
        res.status(200).json(product);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/products/:productId/variants/:variantId/restore */
export async function restoreVariantHandler(req, res, next) {
    try {
        const { storeId, staffMemberId } = requireTenant(req);
        const product = await restoreProductVariant(storeId, productIdParam(req), variantIdParam(req), staffMemberId);
        res.status(200).json(product);
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map