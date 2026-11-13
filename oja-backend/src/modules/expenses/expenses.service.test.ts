import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type $Enums } from "../../../generated/prisma/client.js";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

const activityMocks = vi.hoisted(() => ({ logStoreActivity: vi.fn() }));
vi.mock("../activity/service.js", () => ({
  logStoreActivity: activityMocks.logStoreActivity,
}));

import { createExpense, deleteExpense, listExpenses, updateExpense } from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  expense: {
    findMany: Mock;
    findUnique: Mock;
    create: Mock;
    update: Mock;
    delete: Mock;
  };
  $transaction: Mock;
}

const STORE_ID = "c0000000-0000-4000-8000-000000000001";
const EXPENSE_ID = "c0000000-0000-4000-8000-000000000002";
const STAFF_ID = "c0000000-0000-4000-8000-000000000003";
const D = (v: string | number) => new Prisma.Decimal(v);

const EXPENSE_ROW = {
  id: EXPENSE_ID,
  storeId: STORE_ID,
  category: "RENT" as $Enums.ExpenseCategory,
  amount: D("450000.00"),
  description: "August shop rent",
  date: new Date("2026-08-01T00:00:00.000Z"),
  createdAt: new Date("2026-08-01T09:00:00.000Z"),
  updatedAt: new Date("2026-08-01T09:00:00.000Z"),
};

function createPrismaStub(): PrismaStub {
  return {
    expense: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(),
  };
}

beforeEach(() => {
  activityMocks.logStoreActivity.mockReset();
});

describe("listExpenses", () => {
  it("returns an empty page when no rows match", async () => {
    const stub = createPrismaStub();
    stub.expense.findMany.mockResolvedValue([]);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    const page = await listExpenses(STORE_ID, { limit: "50" });

    expect(page.expenses).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(stub.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: STORE_ID },
        orderBy: { id: "desc" },
        take: 51,
      }),
    );
  });

  it("maps amount to a fixed string and date to YYYY-MM-DD", async () => {
    const stub = createPrismaStub();
    stub.expense.findMany.mockResolvedValue([EXPENSE_ROW]);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    const page = await listExpenses(STORE_ID, {});

    expect(page.expenses[0]).toEqual({
      id: EXPENSE_ID,
      category: "RENT",
      amount: "450000.00",
      description: "August shop rent",
      date: "2026-08-01",
      createdAt: EXPENSE_ROW.createdAt,
      updatedAt: EXPENSE_ROW.updatedAt,
    });
    expect(page.nextCursor).toBeNull();
  });

  it("computes nextCursor when more rows exist than the limit", async () => {
    const stub = createPrismaStub();
    stub.expense.findMany.mockResolvedValue([
      { ...EXPENSE_ROW, id: "c0000000-0000-4000-8000-00000000000a" },
      { ...EXPENSE_ROW, id: "c0000000-0000-4000-8000-00000000000b" },
    ]);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    const page = await listExpenses(STORE_ID, { limit: "1" });

    expect(page.expenses).toHaveLength(1);
    expect(page.nextCursor).toBe("c0000000-0000-4000-8000-00000000000a");
    expect(stub.expense.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
  });

  it("applies category, date-range, and cursor filters", async () => {
    const stub = createPrismaStub();
    stub.expense.findMany.mockResolvedValue([]);
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    await listExpenses(STORE_ID, {
      category: "PACKAGING",
      from: "2026-08-01",
      to: "2026-08-15",
      cursor: EXPENSE_ID,
    });

    const arg = stub.expense.findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(arg.where.category).toBe("PACKAGING");
    expect(arg.where.id).toEqual({ lt: EXPENSE_ID });
    expect(arg.where.date).toEqual({
      gte: new Date("2026-08-01T00:00:00.000Z"),
      lte: new Date("2026-08-15T00:00:00.000Z"),
    });
  });
});

describe("createExpense", () => {
  it("creates the expense and logs expense.created in one transaction", async () => {
    const stub = createPrismaStub();
    stub.expense.create.mockResolvedValue(EXPENSE_ROW);
    stub.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ expense: stub.expense }),
    );
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    const expense = await createExpense(STORE_ID, STAFF_ID, {
      category: "RENT",
      amount: "450000.00",
      description: "August shop rent",
      date: "2026-08-01",
    });

    expect(expense.amount).toBe("450000.00");
    expect(stub.expense.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        category: "RENT",
        amount: "450000.00",
        description: "August shop rent",
        date: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      expect.objectContaining({ expense: stub.expense }),
      {
        storeId: STORE_ID,
        staffMemberId: STAFF_ID,
        action: "expense.created",
        detail: expect.objectContaining({ expenseId: EXPENSE_ID, category: "RENT" }),
      },
    );
  });

  it("logs with an undefined staffMemberId for owner-originated writes", async () => {
    const stub = createPrismaStub();
    stub.expense.create.mockResolvedValue(EXPENSE_ROW);
    stub.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ expense: stub.expense }),
    );
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    await createExpense(STORE_ID, undefined, {
      category: "RENT",
      amount: "450000.00",
      date: "2026-08-01",
    });

    expect(activityMocks.logStoreActivity.mock.calls[0]![1].staffMemberId).toBeUndefined();
  });
});

describe("updateExpense", () => {
  it("rejects a missing or foreign-store expense with EXPENSE_NOT_FOUND", async () => {
    const stub = createPrismaStub();
    stub.expense.findUnique.mockResolvedValue(null);
    stub.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ expense: stub.expense }),
    );
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    await expect(
      updateExpense(STORE_ID, EXPENSE_ID, STAFF_ID, { amount: "500.00" }),
    ).rejects.toMatchObject({ code: "EXPENSE_NOT_FOUND" });
    expect(stub.expense.update).not.toHaveBeenCalled();
  });

  it("updates only the provided fields and logs expense.updated", async () => {
    const stub = createPrismaStub();
    stub.expense.findUnique.mockResolvedValue(EXPENSE_ROW);
    stub.expense.update.mockResolvedValue({ ...EXPENSE_ROW, amount: D("5000.00") });
    stub.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ expense: stub.expense }),
    );
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    const expense = await updateExpense(STORE_ID, EXPENSE_ID, STAFF_ID, { amount: "5000.00" });

    expect(expense.amount).toBe("5000.00");
    expect(stub.expense.update).toHaveBeenCalledWith({
      where: { id: EXPENSE_ID },
      data: { amount: "5000.00" },
    });
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "expense.updated",
        detail: expect.objectContaining({ amount: "5000.00" }),
      }),
    );
  });
});

describe("deleteExpense", () => {
  it("deletes and logs expense.deleted in one transaction", async () => {
    const stub = createPrismaStub();
    stub.expense.findUnique.mockResolvedValue(EXPENSE_ROW);
    stub.expense.delete.mockResolvedValue(EXPENSE_ROW);
    stub.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ expense: stub.expense }),
    );
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    await deleteExpense(STORE_ID, EXPENSE_ID, STAFF_ID);

    expect(stub.expense.delete).toHaveBeenCalledWith({ where: { id: EXPENSE_ID } });
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "expense.deleted",
        detail: expect.objectContaining({ expenseId: EXPENSE_ID, amount: "450000.00" }),
      }),
    );
  });

  it("rejects a foreign-store expense", async () => {
    const stub = createPrismaStub();
    stub.expense.findUnique.mockResolvedValue({ ...EXPENSE_ROW, storeId: "other-store" });
    stub.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ expense: stub.expense }),
    );
    prismaMocks.getPrismaClient.mockReturnValue(stub);

    await expect(deleteExpense(STORE_ID, EXPENSE_ID, STAFF_ID)).rejects.toMatchObject({
      code: "EXPENSE_NOT_FOUND",
    });
    expect(stub.expense.delete).not.toHaveBeenCalled();
  });
});
