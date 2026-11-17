import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import { createUnitSchema, updateUnitSchema, } from "./schemas.js";
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
/**
 * Creates a unit in the tenant's catalog ("kg", "dozen", "pack"). The
 * tenant is always the caller-supplied storeId from req.tenant — never
 * client input. (storeId, name) uniqueness is enforced by the DB; a
 * violation surfaces as 409 UNIT_EXISTS.
 */
export async function createUnit(storeId, input) {
    const data = validateOrThrow(createUnitSchema, input);
    const prisma = getPrismaClient();
    let row;
    try {
        row = await prisma.unit.create({
            data: {
                storeId,
                name: data.name,
                symbol: data.symbol ?? null,
            },
        });
    }
    catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && isUniqueViolation(err, "name")) {
            throw new AppError(409, "UNIT_EXISTS", "A unit with this name already exists");
        }
        throw err;
    }
    await logStoreActivity(prisma, {
        storeId,
        action: "catalog.unit.created",
        detail: { unitId: row.id, name: row.name },
    });
    return row;
}
/** Lists the tenant's units, oldest first. Tenant-scoped. */
export async function listUnits(storeId) {
    return getPrismaClient().unit.findMany({
        where: { storeId },
        orderBy: { createdAt: "asc" },
    });
}
/** Returns one unit; unknown or cross-tenant ids are indistinguishable (404). */
export async function getUnit(storeId, unitId) {
    const row = await getPrismaClient().unit.findFirst({
        where: { id: unitId, storeId },
    });
    if (row === null) {
        throw new AppError(404, "NOT_FOUND", "Unit not found");
    }
    return row;
}
/**
 * Updates only the provided fields. The conditional updateMany is the
 * authority: a zero-row match means unknown or cross-tenant, surfaced as
 * 404. A rename that collides with an existing unit is 409.
 */
export async function updateUnit(storeId, unitId, input) {
    const data = validateOrThrow(updateUnitSchema, input);
    const prisma = getPrismaClient();
    let updated;
    try {
        updated = await prisma.unit.updateMany({
            where: { id: unitId, storeId },
            data: {
                ...(data.name !== undefined ? { name: data.name } : {}),
                ...(data.symbol !== undefined ? { symbol: data.symbol } : {}),
            },
        });
    }
    catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && isUniqueViolation(err, "name")) {
            throw new AppError(409, "UNIT_EXISTS", "A unit with this name already exists");
        }
        throw err;
    }
    if (updated.count === 0) {
        throw new AppError(404, "NOT_FOUND", "Unit not found");
    }
    const row = await prisma.unit.findUniqueOrThrow({ where: { id: unitId } });
    await logStoreActivity(prisma, {
        storeId,
        action: "catalog.unit.updated",
        detail: { unitId, updatedFields: Object.keys(data) },
    });
    return row;
}
/**
 * Hard-deletes the unit. Products keep existing: Product.unitId is
 * SetNull, so attached products simply become unit-less.
 */
export async function deleteUnit(storeId, unitId) {
    const prisma = getPrismaClient();
    const deleted = await prisma.unit.deleteMany({
        where: { id: unitId, storeId },
    });
    if (deleted.count === 0) {
        throw new AppError(404, "NOT_FOUND", "Unit not found");
    }
    await logStoreActivity(prisma, {
        storeId,
        action: "catalog.unit.deleted",
        detail: { unitId },
    });
}
//# sourceMappingURL=units.service.js.map