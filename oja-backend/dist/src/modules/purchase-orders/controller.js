import { AppError } from "../../lib/AppError.js";
import { cancelPurchaseOrder, createPurchaseOrder, deletePurchaseOrder, getPurchaseOrderDetail, issuePurchaseOrder, listPurchaseOrders, receivePurchaseOrder, recordPurchaseOrderPayment, updatePurchaseOrder, } from "./service.js";
function purchaseOrderIdParam(req) {
    const purchaseOrderId = req.params.purchaseOrderId;
    if (typeof purchaseOrderId !== "string" || purchaseOrderId === "") {
        throw new AppError(400, "VALIDATION_ERROR", "Purchase order ID is required");
    }
    return purchaseOrderId;
}
function requireTenant(req) {
    const tenant = req.tenant;
    if (tenant === undefined) {
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    }
    return { storeId: tenant.storeId };
}
/** POST /api/dashboard/purchase-orders */
export async function createPurchaseOrderHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(201).json(await createPurchaseOrder(storeId, req.tenant?.staffMemberId, req.body));
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/purchase-orders */
export async function listPurchaseOrdersHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await listPurchaseOrders(storeId, req.query));
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/purchase-orders/:purchaseOrderId */
export async function getPurchaseOrderHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await getPurchaseOrderDetail(storeId, purchaseOrderIdParam(req)));
    }
    catch (err) {
        next(err);
    }
}
/** PUT /api/dashboard/purchase-orders/:purchaseOrderId */
export async function updatePurchaseOrderHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res
            .status(200)
            .json(await updatePurchaseOrder(storeId, req.tenant?.staffMemberId, purchaseOrderIdParam(req), req.body));
    }
    catch (err) {
        next(err);
    }
}
/** DELETE /api/dashboard/purchase-orders/:purchaseOrderId */
export async function deletePurchaseOrderHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        await deletePurchaseOrder(storeId, req.tenant?.staffMemberId, purchaseOrderIdParam(req));
        res.status(204).send();
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/purchase-orders/:purchaseOrderId/issue */
export async function issuePurchaseOrderHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res
            .status(200)
            .json(await issuePurchaseOrder(storeId, req.tenant?.staffMemberId, purchaseOrderIdParam(req)));
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/purchase-orders/:purchaseOrderId/receive */
export async function receivePurchaseOrderHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res
            .status(200)
            .json(await receivePurchaseOrder(storeId, req.tenant?.staffMemberId, purchaseOrderIdParam(req), req.body));
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/purchase-orders/:purchaseOrderId/payments */
export async function recordPurchaseOrderPaymentHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res
            .status(200)
            .json(await recordPurchaseOrderPayment(storeId, req.tenant?.staffMemberId, purchaseOrderIdParam(req), req.body));
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/purchase-orders/:purchaseOrderId/cancel */
export async function cancelPurchaseOrderHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res
            .status(200)
            .json(await cancelPurchaseOrder(storeId, req.tenant?.staffMemberId, purchaseOrderIdParam(req)));
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map