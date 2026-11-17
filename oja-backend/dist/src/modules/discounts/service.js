import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import { discountCreateSchema, discountUpdateSchema, listDiscountsParamsSchema, } from "./schemas.js";
/** Maps a discount relation (Decimal value) to its embedded summary shape. */
export function toDiscountSummary(discount) {
    return {
        id: discount.id,
        name: discount.name,
        type: discount.type,
        value: discount.value.toFixed(2),
    };
}
/** True when a Prisma P2002 unique-violation targets the given column. */
function isUniqueViolation(err, field) {
    if (typeof err !== "object" || err === null)
        return false;
    const { code, meta } = err;
    if (code !== "P2002")
        return false;
    const candidates = [];
    const rawMeta = meta;
    const target = rawMeta.target;
    if (Array.isArray(target)) {
        candidates.push(...target.map(String));
    }
    else if (typeof target === "string" || typeof target === "object") {
        const column = typeof target === "object" && target !== null && "column" in target
            ? target.column
            : target;
        if (typeof column === "string")
            candidates.push(column);
    }
    const constraint = rawMeta.driverAdapterError?.cause?.constraint;
    if (typeof constraint === "string") {
        candidates.push(constraint);
    }
    else if (typeof constraint === "object" && constraint !== null) {
        const fields = constraint.fields;
        if (Array.isArray(fields))
            candidates.push(...fields.map(String));
    }
    return candidates.includes(field) || candidates.some((c) => c.endsWith(`_${field}_key`));
}
function mapRow(row) {
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        value: row.value.toFixed(2),
        code: row.code,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        isActive: row.isActive,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
/** Cursor-paginated, newest-first discounts with optional filters. */
export async function listDiscounts(storeId, rawParams) {
    const params = validateOrThrow(listDiscountsParamsSchema, rawParams);
    const prisma = getPrismaClient();
    const where = { storeId };
    if (params.isActive !== undefined)
        where.isActive = params.isActive;
    if (params.type !== undefined)
        where.type = params.type;
    if (params.cursor !== undefined)
        where.id = { lt: params.cursor };
    const rows = await prisma.discount.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: params.limit,
    });
    const nextCursor = rows.length === params.limit && rows.length > 0 ? rows[rows.length - 1].id : null;
    return { items: rows.map(mapRow), nextCursor };
}
/** Creates a discount; a duplicate code is 409 DISCOUNT_CODE_TAKEN. */
export async function createDiscount(storeId, staffMemberId, rawInput) {
    const data = validateOrThrow(discountCreateSchema, rawInput);
    const prisma = getPrismaClient();
    let row;
    try {
        row = await prisma.discount.create({
            data: {
                storeId,
                name: data.name,
                type: data.type,
                value: data.value,
                code: data.code ?? null,
                startsAt: data.startsAt ?? null,
                endsAt: data.endsAt ?? null,
                isActive: data.isActive ?? true,
            },
        });
    }
    catch (err) {
        if (isUniqueViolation(err, "code")) {
            throw new AppError(409, "DISCOUNT_CODE_TAKEN", "A discount with this code already exists");
        }
        throw err;
    }
    await logStoreActivity(prisma, {
        storeId,
        staffMemberId: staffMemberId ?? null,
        action: "discount.created",
        detail: { discountId: row.id, name: row.name },
    });
    return mapRow(row);
}
/** One discount; unknown or cross-tenant ids are indistinguishable (404). */
export async function getDiscount(storeId, discountId) {
    const row = await getPrismaClient().discount.findFirst({
        where: { id: discountId, storeId },
    });
    if (row === null) {
        throw new AppError(404, "DISCOUNT_NOT_FOUND", "Discount not found");
    }
    return mapRow(row);
}
/**
 * Updates only the provided fields. The conditional updateMany is the
 * authority: a zero-row match means unknown or cross-tenant (404). A
 * code collision is 409; explicit null clears code/startsAt/endsAt.
 */
export async function updateDiscount(storeId, staffMemberId, discountId, rawInput) {
    const data = validateOrThrow(discountUpdateSchema, rawInput);
    const prisma = getPrismaClient();
    let updated;
    try {
        updated = await prisma.discount.updateMany({
            where: { id: discountId, storeId },
            data: {
                ...(data.name !== undefined ? { name: data.name } : {}),
                ...(data.type !== undefined ? { type: data.type } : {}),
                ...(data.value !== undefined ? { value: data.value } : {}),
                ...(data.code !== undefined ? { code: data.code } : {}),
                ...(data.startsAt !== undefined ? { startsAt: data.startsAt } : {}),
                ...(data.endsAt !== undefined ? { endsAt: data.endsAt } : {}),
                ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
            },
        });
    }
    catch (err) {
        if (isUniqueViolation(err, "code")) {
            throw new AppError(409, "DISCOUNT_CODE_TAKEN", "A discount with this code already exists");
        }
        throw err;
    }
    if (updated.count === 0) {
        throw new AppError(404, "DISCOUNT_NOT_FOUND", "Discount not found");
    }
    const row = await prisma.discount.findUniqueOrThrow({ where: { id: discountId } });
    await logStoreActivity(prisma, {
        storeId,
        staffMemberId: staffMemberId ?? null,
        action: "discount.updated",
        detail: { discountId, updatedFields: Object.keys(data) },
    });
    return mapRow(row);
}
/**
 * Deletes a discount. Orders and groups that referenced it are not
 * blocked: captured discountAmount stays, affected groups simply lose
 * their auto-applied discount (SetNull). The conditional delete is the
 * authority; zero-row match = 404.
 */
export async function deleteDiscount(storeId, staffMemberId, discountId) {
    const prisma = getPrismaClient();
    const deleted = await prisma.discount.deleteMany({
        where: { id: discountId, storeId },
    });
    if (deleted.count === 0) {
        throw new AppError(404, "DISCOUNT_NOT_FOUND", "Discount not found");
    }
    await logStoreActivity(prisma, {
        storeId,
        staffMemberId: staffMemberId ?? null,
        action: "discount.deleted",
        detail: { discountId },
    });
}
//# sourceMappingURL=service.js.map