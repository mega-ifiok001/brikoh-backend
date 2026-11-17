import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import { bankAccountCreateSchema, businessProfileSchema, NOTIFICATION_TOGGLE_KEYS, notificationSettingsUpdateSchema, } from "./schemas.js";
/** Reads the persisted business profile (the read half of onboarding). */
export async function getBusinessProfile(storeId) {
    const store = await getPrismaClient().store.findUnique({
        where: { id: storeId },
        select: {
            id: true,
            name: true,
            businessType: true,
            location: true,
            currency: true,
            businessPhone: true,
        },
    });
    if (store === null) {
        throw new AppError(404, "NOT_FOUND", "Store not found");
    }
    return {
        storeId: store.id,
        name: store.name,
        businessType: store.businessType,
        location: store.location,
        currency: store.currency,
        businessPhone: store.businessPhone,
    };
}
/**
 * Updates the store's business profile (full replace, same rules as
 * onboarding) and writes a store.settings.updated activity entry.
 * Owner-only in the route; the service trusts the caller's authority.
 */
export async function updateBusinessProfile(storeId, staffMemberId, input) {
    const data = validateOrThrow(businessProfileSchema, input);
    const prisma = getPrismaClient();
    const store = await prisma.$transaction(async (tx) => {
        const updated = await tx.store.update({
            where: { id: storeId },
            data: {
                name: data.name,
                businessType: data.businessType,
                location: data.location,
                currency: data.currency,
                businessPhone: data.businessPhone,
            },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "store.settings.updated",
            detail: {
                fields: ["name", "businessType", "location", "currency", "businessPhone"],
            },
        });
        return updated;
    });
    return {
        storeId: store.id,
        name: store.name,
        businessType: store.businessType,
        location: store.location,
        currency: store.currency,
        businessPhone: store.businessPhone,
    };
}
/** Default for unset toggles: every alert is enabled. */
const DEFAULT_NOTIFICATION_SETTINGS = {
    lowStockAlerts: true,
    paymentAlerts: true,
    expiringSoonAlerts: true,
    receiptsEnabled: true,
};
/**
 * Reads the store's notification toggles. Unset keys default to enabled
 * — the complete known set is always returned.
 */
export async function getNotificationSettings(storeId) {
    const store = await getPrismaClient().store.findUnique({
        where: { id: storeId },
        select: { notificationSettings: true },
    });
    if (store === null) {
        throw new AppError(404, "NOT_FOUND", "Store not found");
    }
    const raw = store.notificationSettings;
    const stored = (typeof raw === "object" && raw !== null ? raw : {});
    const result = { ...DEFAULT_NOTIFICATION_SETTINGS };
    for (const key of NOTIFICATION_TOGGLE_KEYS) {
        const value = stored[key];
        if (typeof value === "boolean") {
            result[key] = value;
        }
    }
    return result;
}
/**
 * Merges the supplied toggles into the store's settings (unknown keys
 * rejected by the schema) and returns the full persisted set.
 */
export async function updateNotificationSettings(storeId, staffMemberId, input) {
    const data = validateOrThrow(notificationSettingsUpdateSchema, input);
    const prisma = getPrismaClient();
    const current = await getNotificationSettings(storeId);
    const merged = { ...current, ...data };
    await prisma.$transaction(async (tx) => {
        await tx.store.update({
            where: { id: storeId },
            data: { notificationSettings: merged },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "store.settings.notifications.updated",
            detail: { toggles: Object.keys(data) },
        });
    });
    return merged;
}
function toBankAccountView(row) {
    return {
        id: row.id,
        accountName: row.accountName,
        bankName: row.bankName,
        accountNumber: row.accountNumber ?? "",
        isDefault: row.isDefault,
    };
}
/**
 * Adds a merchant bank account. When isDefault is true, any existing default
 * is cleared first so exactly one account is default at a time. The whole
 * write (demotion + create + activity log) is one transaction.
 */
export async function createBankAccount(storeId, input, staffMemberId) {
    const data = validateOrThrow(bankAccountCreateSchema, input);
    const prisma = getPrismaClient();
    return prisma
        .$transaction(async (tx) => {
        if (data.isDefault === true) {
            await tx.bankAccount.updateMany({
                where: { storeId, isDefault: true },
                data: { isDefault: false },
            });
        }
        const created = await tx.bankAccount.create({
            data: {
                storeId,
                accountName: data.accountName,
                bankName: data.bankName,
                accountNumber: data.accountNumber,
                isDefault: data.isDefault ?? false,
            },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "store.bankaccount.created",
            detail: { id: created.id, isDefault: created.isDefault },
        });
        return created;
    })
        .then(toBankAccountView);
}
/** Lists the store's bank accounts (default first). */
export async function listBankAccounts(storeId) {
    const rows = await getPrismaClient().bankAccount.findMany({
        where: { storeId },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    return rows.map(toBankAccountView);
}
//# sourceMappingURL=service.js.map