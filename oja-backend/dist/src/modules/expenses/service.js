import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import { expenseCreateSchema, expenseUpdateSchema, listExpensesParamsSchema } from "./schemas.js";
/** Maps a Prisma expense row to its API shape (amount toFixed, date as YYYY-MM-DD). */
function toExpenseRow(expense) {
    return {
        id: expense.id,
        category: expense.category,
        amount: expense.amount.toFixed(2),
        description: expense.description,
        date: expense.date.toISOString().slice(0, 10),
        createdAt: expense.createdAt,
        updatedAt: expense.updatedAt,
    };
}
/** Date-only string -> UTC midnight Date (the DATE column's canonical value). */
export function parseExpenseDate(value) {
    return new Date(`${value}T00:00:00.000Z`);
}
/** True when a Prisma P2025 not-found error occurred (row is gone). */
function isNotFound(err) {
    return typeof err === "object" && err !== null && err.code === "P2025";
}
export async function listExpenses(storeId, query) {
    const params = validateOrThrow(listExpensesParamsSchema, query);
    const where = { storeId };
    if (params.category !== undefined) {
        where.category = params.category;
    }
    if (params.from !== undefined || params.to !== undefined) {
        where.date = {
            ...(params.from !== undefined ? { gte: parseExpenseDate(params.from) } : {}),
            ...(params.to !== undefined ? { lte: parseExpenseDate(params.to) } : {}),
        };
    }
    if (params.cursor !== undefined) {
        where.id = { lt: params.cursor };
    }
    const rows = await getPrismaClient().expense.findMany({
        where,
        orderBy: { id: "desc" },
        take: params.limit + 1,
    });
    const hasMore = rows.length > params.limit;
    const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
    return {
        expenses: pageRows.map(toExpenseRow),
        nextCursor: hasMore ? pageRows[pageRows.length - 1].id : null,
    };
}
export async function createExpense(storeId, staffMemberId, body) {
    const data = validateOrThrow(expenseCreateSchema, body);
    return getPrismaClient().$transaction(async (tx) => {
        const expense = await tx.expense.create({
            data: {
                storeId,
                category: data.category,
                amount: data.amount,
                description: data.description ?? null,
                date: parseExpenseDate(data.date),
            },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId,
            action: "expense.created",
            detail: { expenseId: expense.id, category: expense.category, amount: data.amount },
        });
        return toExpenseRow(expense);
    });
}
export async function updateExpense(storeId, expenseId, staffMemberId, body) {
    const data = validateOrThrow(expenseUpdateSchema, body);
    try {
        return await getPrismaClient().$transaction(async (tx) => {
            const existing = await tx.expense.findUnique({ where: { id: expenseId } });
            if (existing === null || existing.storeId !== storeId) {
                throw new AppError(404, "EXPENSE_NOT_FOUND", "Expense not found");
            }
            const expense = await tx.expense.update({
                where: { id: expenseId },
                data: {
                    ...(data.category !== undefined ? { category: data.category } : {}),
                    ...(data.amount !== undefined ? { amount: data.amount } : {}),
                    ...(data.description !== undefined ? { description: data.description ?? null } : {}),
                    ...(data.date !== undefined ? { date: parseExpenseDate(data.date) } : {}),
                },
            });
            await logStoreActivity(tx, {
                storeId,
                staffMemberId,
                action: "expense.updated",
                detail: { expenseId: expense.id, category: expense.category, amount: data.amount ?? null },
            });
            return toExpenseRow(expense);
        });
    }
    catch (err) {
        if (isNotFound(err)) {
            throw new AppError(404, "EXPENSE_NOT_FOUND", "Expense not found");
        }
        throw err;
    }
}
export async function deleteExpense(storeId, expenseId, staffMemberId) {
    try {
        await getPrismaClient().$transaction(async (tx) => {
            const expense = await tx.expense.findUnique({ where: { id: expenseId } });
            if (expense === null || expense.storeId !== storeId) {
                throw new AppError(404, "EXPENSE_NOT_FOUND", "Expense not found");
            }
            await tx.expense.delete({ where: { id: expenseId } });
            await logStoreActivity(tx, {
                storeId,
                staffMemberId,
                action: "expense.deleted",
                detail: {
                    expenseId: expense.id,
                    category: expense.category,
                    amount: expense.amount.toFixed(2),
                },
            });
        });
    }
    catch (err) {
        if (isNotFound(err)) {
            throw new AppError(404, "EXPENSE_NOT_FOUND", "Expense not found");
        }
        throw err;
    }
}
//# sourceMappingURL=service.js.map