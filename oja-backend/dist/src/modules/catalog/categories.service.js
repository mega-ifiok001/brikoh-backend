import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import { createCategorySchema, updateCategorySchema, } from "./schemas.js";
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
 * Creates a category in the tenant's catalog. The tenant is always the
 * caller-supplied storeId from req.tenant — never client input. The
 * (storeId, name) unique constraint is enforced by the DB; a violation
 * surfaces as 409 CATEGORY_EXISTS so the client can prompt for a rename
 * instead of receiving a 500.
 */
export async function createCategory(storeId, input) {
    const data = validateOrThrow(createCategorySchema, input);
    const prisma = getPrismaClient();
    let row;
    try {
        row = await prisma.category.create({
            data: {
                storeId,
                name: data.name,
                description: data.description ?? null,
            },
        });
    }
    catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && isUniqueViolation(err, "name")) {
            throw new AppError(409, "CATEGORY_EXISTS", "A category with this name already exists");
        }
        throw err;
    }
    await logStoreActivity(prisma, {
        storeId,
        action: "catalog.category.created",
        detail: { categoryId: row.id, name: row.name },
    });
    return row;
}
/**
 * Lists the tenant's categories, oldest first. Tenant-scoped: never
 * returns another store's categories.
 */
export async function listCategories(storeId) {
    return getPrismaClient().category.findMany({
        where: { storeId },
        orderBy: { createdAt: "asc" },
    });
}
/** Returns one category; unknown or cross-tenant ids are indistinguishable (404). */
export async function getCategory(storeId, categoryId) {
    const row = await getPrismaClient().category.findFirst({
        where: { id: categoryId, storeId },
    });
    if (row === null) {
        throw new AppError(404, "NOT_FOUND", "Category not found");
    }
    return row;
}
/**
 * Updates only the provided fields. The conditional updateMany is the
 * authority: a zero-row match means unknown or cross-tenant, surfaced as
 * 404. A rename that collides with an existing category is 409.
 */
export async function updateCategory(storeId, categoryId, input) {
    const data = validateOrThrow(updateCategorySchema, input);
    const prisma = getPrismaClient();
    let updated;
    try {
        updated = await prisma.category.updateMany({
            where: { id: categoryId, storeId },
            data: {
                ...(data.name !== undefined ? { name: data.name } : {}),
                ...(data.description !== undefined ? { description: data.description } : {}),
            },
        });
    }
    catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && isUniqueViolation(err, "name")) {
            throw new AppError(409, "CATEGORY_EXISTS", "A category with this name already exists");
        }
        throw err;
    }
    if (updated.count === 0) {
        throw new AppError(404, "NOT_FOUND", "Category not found");
    }
    const row = await prisma.category.findUniqueOrThrow({ where: { id: categoryId } });
    await logStoreActivity(prisma, {
        storeId,
        action: "catalog.category.updated",
        detail: { categoryId, updatedFields: Object.keys(data) },
    });
    return row;
}
/**
 * Hard-deletes the category. Products keep existing: Product.categoryId
 * is SetNull, so attached products simply become uncategorized. The
 * conditional delete is the authority; zero-row match = 404.
 */
export async function deleteCategory(storeId, categoryId) {
    const prisma = getPrismaClient();
    const deleted = await prisma.category.deleteMany({
        where: { id: categoryId, storeId },
    });
    if (deleted.count === 0) {
        throw new AppError(404, "NOT_FOUND", "Category not found");
    }
    await logStoreActivity(prisma, {
        storeId,
        action: "catalog.category.deleted",
        detail: { categoryId },
    });
}
//# sourceMappingURL=categories.service.js.map