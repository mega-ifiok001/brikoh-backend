import { AppError } from "../../lib/AppError.js";
import { createBankAccount, getBusinessProfile, getNotificationSettings, listBankAccounts, updateBusinessProfile, updateNotificationSettings, } from "./service.js";
import { createDeliveryOption, deleteDeliveryOption, listDeliveryOptions, updateDeliveryOption, } from "./delivery-options.service.js";
function requireTenant(req) {
    const tenant = req.tenant;
    if (tenant === undefined) {
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    }
    return { storeId: tenant.storeId };
}
/** GET /api/dashboard/settings/business */
export async function getBusinessProfileHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await getBusinessProfile(storeId));
    }
    catch (err) {
        next(err);
    }
}
/** PUT /api/dashboard/settings/business */
export async function updateBusinessProfileHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await updateBusinessProfile(storeId, req.tenant?.staffMemberId, req.body));
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/settings/notifications */
export async function getNotificationSettingsHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await getNotificationSettings(storeId));
    }
    catch (err) {
        next(err);
    }
}
/** PUT /api/dashboard/settings/notifications */
export async function updateNotificationSettingsHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res
            .status(200)
            .json(await updateNotificationSettings(storeId, req.tenant?.staffMemberId, req.body));
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/settings/bank-accounts */
export async function listBankAccountsHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json(await listBankAccounts(storeId));
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/settings/bank-accounts */
export async function createBankAccountHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(201).json(await createBankAccount(storeId, req.body, req.tenant?.staffMemberId));
    }
    catch (err) {
        next(err);
    }
}
function optionIdParam(req) {
    const value = req.params.optionId;
    if (typeof value !== "string" || value === "") {
        throw new AppError(400, "VALIDATION_ERROR", "Delivery option ID is required");
    }
    return value;
}
/** GET /api/dashboard/settings/delivery-options */
export async function listDeliveryOptionsHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res.status(200).json({ deliveryOptions: await listDeliveryOptions(storeId) });
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/settings/delivery-options */
export async function createDeliveryOptionHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res
            .status(201)
            .json(await createDeliveryOption(storeId, req.body, req.tenant?.staffMemberId));
    }
    catch (err) {
        next(err);
    }
}
/** PUT /api/dashboard/settings/delivery-options/:optionId */
export async function updateDeliveryOptionHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        res
            .status(200)
            .json(await updateDeliveryOption(storeId, optionIdParam(req), req.body, req.tenant?.staffMemberId));
    }
    catch (err) {
        next(err);
    }
}
/** DELETE /api/dashboard/settings/delivery-options/:optionId */
export async function deleteDeliveryOptionHandler(req, res, next) {
    try {
        const { storeId } = requireTenant(req);
        await deleteDeliveryOption(storeId, optionIdParam(req), req.tenant?.staffMemberId);
        res.status(204).end();
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map