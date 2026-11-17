import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import { transferStock as transferStockLedger } from "../products/ledger.service.js";
import { createBranchSchema, transferStockSchema, updateBranchSchema, } from "./schemas.js";
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
    return candidates.some((candidate) => candidate.toLowerCase() === field.toLowerCase());
}
async function toRow(branch, defaultBranchId) {
    return {
        id: branch.id,
        storeId: branch.storeId,
        name: branch.name,
        address: branch.address,
        isDefault: branch.id === defaultBranchId,
        createdAt: branch.createdAt,
        updatedAt: branch.updatedAt,
    };
}
/**
 * Creates a branch in the tenant's set. The tenant is always the
 * caller-supplied storeId from req.tenant — never client input.
 * (storeId, name) is unique: a duplicate name is 409 BRANCH_EXISTS.
 * A new branch starts with NO stock anywhere — existing products live
 * on the branches they were created/transferred to; the first transfer
 * into this branch creates its BranchStock rows (ensure-on-increment).
 */
export async function createBranch(storeId, input, staffMemberId) {
    const data = validateOrThrow(createBranchSchema, input);
    const prisma = getPrismaClient();
    let branch;
    try {
        const created = await prisma.$transaction(async (tx) => {
            const row = await tx.branch.create({
                data: { storeId, name: data.name, address: data.address ?? null },
            });
            await logStoreActivity(tx, {
                storeId,
                staffMemberId,
                action: "branch.created",
                detail: { branchId: row.id, name: row.name },
            });
            return row;
        });
        const store = await prisma.store.findUnique({
            where: { id: storeId },
            select: { defaultBranchId: true },
        });
        branch = await toRow(created, store?.defaultBranchId ?? null);
    }
    catch (err) {
        if (isUniqueViolation(err, "name")) {
            throw new AppError(409, "BRANCH_EXISTS", "A branch with this name already exists");
        }
        throw err;
    }
    return branch;
}
/** Lists the tenant's branches, oldest first, with the default flagged. */
export async function listBranches(storeId) {
    const prisma = getPrismaClient();
    const [branches, store] = await Promise.all([
        prisma.branch.findMany({ where: { storeId }, orderBy: { createdAt: "asc" } }),
        prisma.store.findUnique({ where: { id: storeId }, select: { defaultBranchId: true } }),
    ]);
    const defaultBranchId = store?.defaultBranchId ?? null;
    return Promise.all(branches.map((branch) => toRow(branch, defaultBranchId)));
}
/** Returns one branch of the tenant (404 for unknown/cross-tenant). */
export async function getBranch(storeId, branchId) {
    const prisma = getPrismaClient();
    const [branch, store] = await Promise.all([
        prisma.branch.findFirst({ where: { id: branchId, storeId } }),
        prisma.store.findUnique({ where: { id: storeId }, select: { defaultBranchId: true } }),
    ]);
    if (branch === null) {
        throw new AppError(404, "BRANCH_NOT_FOUND", "Branch not found");
    }
    return toRow(branch, store?.defaultBranchId ?? null);
}
/** Renames a branch / edits its address. */
export async function updateBranch(storeId, branchId, input, staffMemberId) {
    const data = validateOrThrow(updateBranchSchema, input);
    const prisma = getPrismaClient();
    try {
        const updated = await prisma.$transaction(async (tx) => {
            const existing = await tx.branch.findFirst({
                where: { id: branchId, storeId },
                select: { id: true, name: true },
            });
            if (existing === null) {
                throw new AppError(404, "BRANCH_NOT_FOUND", "Branch not found");
            }
            const row = await tx.branch.update({
                where: { id: branchId },
                data: {
                    ...(data.name !== undefined ? { name: data.name } : {}),
                    ...(data.address !== undefined ? { address: data.address } : {}),
                },
            });
            await logStoreActivity(tx, {
                storeId,
                staffMemberId,
                action: "branch.updated",
                detail: { branchId, previousName: existing.name },
            });
            return row;
        });
        const store = await prisma.store.findUnique({
            where: { id: storeId },
            select: { defaultBranchId: true },
        });
        return toRow(updated, store?.defaultBranchId ?? null);
    }
    catch (err) {
        if (isUniqueViolation(err, "name")) {
            throw new AppError(409, "BRANCH_EXISTS", "A branch with this name already exists");
        }
        throw err;
    }
}
/**
 * Makes the given branch the store's default — the branch public
 * checkout and staff sales resolve against. Any tenant branch can
 * become default (the old default simply loses the flag).
 */
export async function setDefaultBranch(storeId, branchId, staffMemberId) {
    const prisma = getPrismaClient();
    const branch = await prisma.$transaction(async (tx) => {
        const existing = await tx.branch.findFirst({
            where: { id: branchId, storeId },
            select: { id: true },
        });
        if (existing === null) {
            throw new AppError(404, "BRANCH_NOT_FOUND", "Branch not found");
        }
        await tx.store.update({ where: { id: storeId }, data: { defaultBranchId: branchId } });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId,
            action: "branch.default_changed",
            detail: { branchId },
        });
        return existing;
    });
    return getBranch(storeId, branch.id);
}
/**
 * Deletes a branch. Service-gated:
 *  - the default branch can never be deleted (409 DEFAULT_BRANCH) —
 *    transfer its stock away and make another branch default first;
 *  - a branch holding stock must be emptied first (409 BRANCH_HAS_STOCK);
 *  - a branch with order history cannot be deleted (409 BRANCH_HAS_ORDERS)
 *    — financial records must keep their branch attribution.
 * Ledger history keeps the branch's rows (branchId is SetNull), matching
 * the staff-removal pattern.
 */
export async function deleteBranch(storeId, branchId, staffMemberId) {
    const prisma = getPrismaClient();
    try {
        return await prisma.$transaction(async (tx) => {
            const branch = await tx.branch.findFirst({
                where: { id: branchId, storeId },
                select: { id: true },
            });
            if (branch === null) {
                throw new AppError(404, "BRANCH_NOT_FOUND", "Branch not found");
            }
            const store = await tx.store.findUnique({
                where: { id: storeId },
                select: { defaultBranchId: true },
            });
            if (store?.defaultBranchId === branchId) {
                throw new AppError(409, "DEFAULT_BRANCH", "The default branch cannot be deleted — make another branch the default first");
            }
            const held = await tx.branchStock.aggregate({
                where: { branchId },
                _sum: { quantity: true },
            });
            if ((held._sum.quantity ?? 0) > 0) {
                throw new AppError(409, "BRANCH_HAS_STOCK", "This branch still holds stock — transfer it out before deleting the branch");
            }
            await tx.branch.delete({ where: { id: branchId } });
            await logStoreActivity(tx, {
                storeId,
                staffMemberId,
                action: "branch.deleted",
                detail: { branchId },
            });
            return { id: branchId };
        });
    }
    catch (err) {
        // Order.branchId is Restrict: a branch with any order history cannot
        // be deleted at the DB level — surface it as a clear 409. Prisma 7
        // with the pg driver adapter surfaces FK restrict violations as
        // P2039 (nested driver code 23001); older engine-based clients used
        // P2003, so both are handled.
        const knownErr = err;
        const code = knownErr.code ?? knownErr.meta?.driverAdapterError?.cause?.originalCode;
        if (code === "P2003" || code === "P2039" || code === "23001") {
            throw new AppError(409, "BRANCH_HAS_ORDERS", "This branch has order history and cannot be deleted");
        }
        throw err;
    }
}
/**
 * The branch-to-branch stock movement (doc flow 4.6) — delegates to the
 * ledger's transferStock, which owns the atomicity: TRANSFER_OUT on the
 * source, TRANSFER_IN on the destination, one transaction, guarded
 * decrement. Returns both legs' post-movement state.
 */
export async function transferStock(storeId, input, staffMemberId) {
    const data = validateOrThrow(transferStockSchema, input);
    const prisma = getPrismaClient();
    const result = await transferStockLedger(storeId, { ...data, performedByStaffId: staffMemberId });
    await logStoreActivity(prisma, {
        storeId,
        staffMemberId,
        action: "stock.transferred",
        detail: {
            productId: data.productId,
            variantId: data.variantId ?? null,
            sourceBranchId: data.sourceBranchId,
            destinationBranchId: data.destinationBranchId,
            quantity: data.quantity,
        },
    });
    return {
        productId: data.productId,
        variantId: data.variantId ?? null,
        quantity: data.quantity,
        sourceBranch: {
            branchId: data.sourceBranchId,
            quantityChange: -data.quantity,
            stockAfter: result.source.branchStockAfter,
        },
        destinationBranch: {
            branchId: data.destinationBranchId,
            quantityChange: data.quantity,
            stockAfter: result.destination.branchStockAfter,
        },
    };
}
//# sourceMappingURL=service.js.map