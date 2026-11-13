import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client.js";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

const activityMocks = vi.hoisted(() => ({ logStoreActivity: vi.fn() }));
vi.mock("../activity/service.js", () => ({
  logStoreActivity: activityMocks.logStoreActivity,
}));

const ordersMocks = vi.hoisted(() => ({ listOrders: vi.fn() }));
vi.mock("../orders/service.js", () => ({
  listOrders: ordersMocks.listOrders,
}));

import {
  createCustomer,
  deleteCustomer,
  getCustomerDetail,
  listCustomers,
  recordCreditRepayment,
  updateCustomer,
} from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  $transaction: Mock;
  customer: { findFirst: Mock; findMany: Mock; create: Mock; update: Mock; delete: Mock };
  customerGroup: { findFirst: Mock; create: Mock };
  order: {
    findMany: Mock;
    groupBy: Mock;
    update: Mock;
    fields: { total: unknown };
  };
  creditRepayment: { findMany: Mock; create: Mock };
  // The payment-alert hook looks the store up before alerting; resolving
  // null (no store) keeps the hook a silent no-op in these unit tests.
  store: { findUnique: Mock };
}

const STORE_ID = "store-1";
const CUSTOMER_ID = "customer-1";
const STAFF_ID = "staff-1";
const D = (v: string) => new Prisma.Decimal(v);

const CUSTOMER_ROW = {
  id: CUSTOMER_ID,
  name: "Ade Okafor",
  phone: "+2348012345678",
  email: "ade@example.com",
  source: "MANUAL",
  group: { id: "group-general", name: "General" },
  createdAt: new Date("2026-08-01T10:00:00.000Z"),
};

function createPrismaStub(): PrismaStub {
  return {
    $transaction: vi.fn(),
    customer: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    customerGroup: {
      findFirst: vi.fn().mockResolvedValue({ id: "group-general" }),
      create: vi.fn(),
    },
    order: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      update: vi.fn(),
      fields: { total: "total" },
    },
    creditRepayment: { findMany: vi.fn(), create: vi.fn() },
    store: { findUnique: vi.fn() },
  };
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createPrismaStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  stub.customer.findFirst.mockResolvedValue(null);
  stub.store.findUnique.mockResolvedValue(null);
  activityMocks.logStoreActivity.mockReset();
  activityMocks.logStoreActivity.mockResolvedValue(undefined);
  ordersMocks.listOrders.mockReset();
  ordersMocks.listOrders.mockResolvedValue({ items: [], nextCursor: null });
  // Both list/detail aggregates default to "no orders" for this customer.
  stub.order.groupBy.mockResolvedValue([]);
  // Transactions run the callback against the same stub.
  stub.$transaction.mockImplementation(async (fn: (tx: PrismaStub) => Promise<unknown>) =>
    fn(stub),
  );
});

describe("listCustomers (unit)", () => {
  it("pages newest-first and attaches derived open credit per customer", async () => {
    stub.customer.findMany.mockResolvedValue([
      { ...CUSTOMER_ROW, id: "customer-2", createdAt: new Date("2026-08-02T10:00:00.000Z") },
      CUSTOMER_ROW,
    ]);
    stub.order.groupBy.mockResolvedValue([
      { customerId: CUSTOMER_ID, _count: { _all: 2 }, _sum: { total: D("5000.00") } },
    ]);
    stub.order.findMany.mockResolvedValue([
      { customerId: CUSTOMER_ID, total: D("5000.00"), amountPaid: D("1500.00") },
      { customerId: CUSTOMER_ID, total: D("100.00"), amountPaid: D("100.00") },
      // A fully-paid credit order never counts as owing.
      { customerId: "customer-2", total: D("900.00"), amountPaid: D("900.00") },
    ]);

    const result = await listCustomers(STORE_ID, { limit: 20 });

    expect(result.items[0]).toEqual({
      id: "customer-2",
      name: "Ade Okafor",
      phone: "+2348012345678",
      email: "ade@example.com",
      group: { id: "group-general", name: "General" },
      source: "MANUAL",
      segment: "NEW",
      ordersCount: 0,
      totalSpent: "0.00",
      openCredit: "0.00",
      hasOutstandingCredit: false,
      createdAt: new Date("2026-08-02T10:00:00.000Z"),
    });
    expect(result.items[1]).toEqual({
      id: CUSTOMER_ID,
      name: "Ade Okafor",
      phone: "+2348012345678",
      email: "ade@example.com",
      group: { id: "group-general", name: "General" },
      source: "MANUAL",
      segment: "REGULAR",
      ordersCount: 2,
      totalSpent: "5000.00",
      openCredit: "3500.00",
      hasOutstandingCredit: true,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    expect(stub.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    );
    expect(stub.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: STORE_ID,
          paymentMethod: "CREDIT",
          status: { in: ["PENDING", "PAID", "SHIPPED"] },
        }),
      }),
    );
  });

  it("applies the cursor and the q search across name/phone/email", async () => {
    stub.customer.findMany.mockResolvedValue([]);
    stub.order.findMany.mockResolvedValue([]);

    await listCustomers(STORE_ID, {
      cursor: "c0000000-0000-4000-8000-000000000001",
      q: "okafor",
      limit: 5,
    });

    const call = stub.customer.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(call.where).toMatchObject({
      storeId: STORE_ID,
      id: { lt: "c0000000-0000-4000-8000-000000000001" },
    });
    expect(call.where.OR).toEqual([
      { name: { contains: "okafor", mode: "insensitive" } },
      { phone: { contains: "okafor", mode: "insensitive" } },
      { email: { contains: "okafor", mode: "insensitive" } },
    ]);
  });

  it("filters by hasOutstandingCredit and reports nextCursor", async () => {
    stub.customer.findMany.mockResolvedValue([CUSTOMER_ROW]);
    stub.order.findMany.mockResolvedValue([
      { customerId: CUSTOMER_ID, total: D("100.00"), amountPaid: D("0.00") },
    ]);

    const withCredit = await listCustomers(STORE_ID, { hasOutstandingCredit: "true", limit: 20 });
    expect(withCredit.items).toHaveLength(1);
    const without = await listCustomers(STORE_ID, { hasOutstandingCredit: "false", limit: 20 });
    expect(without.items).toHaveLength(0);
    expect(withCredit.nextCursor).toBeNull();
  });

  it("returns nextCursor when a full page was fetched", async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({
      ...CUSTOMER_ROW,
      id: `customer-${i}`,
    }));
    stub.customer.findMany.mockResolvedValue(rows);
    stub.order.findMany.mockResolvedValue([]);

    const result = await listCustomers(STORE_ID, { limit: 2 });
    expect(result.nextCursor).toBe("customer-1");
  });
});

describe("createCustomer (unit)", () => {
  it("creates the customer, logs customer.created, and reports a zero balance", async () => {
    stub.customer.create.mockResolvedValue(CUSTOMER_ROW);

    const result = await createCustomer(STORE_ID, STAFF_ID, {
      name: "Ade Okafor",
      phone: "+2348012345678",
      email: "ade@example.com",
    });

    expect(result).toEqual({
      id: CUSTOMER_ID,
      name: "Ade Okafor",
      phone: "+2348012345678",
      email: "ade@example.com",
      group: { id: "group-general", name: "General" },
      source: "MANUAL",
      segment: "NEW",
      ordersCount: 0,
      totalSpent: "0.00",
      openCredit: "0.00",
      hasOutstandingCredit: false,
      createdAt: CUSTOMER_ROW.createdAt,
    });
    expect(stub.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storeId: STORE_ID, email: "ade@example.com" }),
      }),
    );
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(stub, {
      storeId: STORE_ID,
      staffMemberId: STAFF_ID,
      action: "customer.created",
      detail: { customerId: CUSTOMER_ID },
    });
  });

  it("rejects a duplicate email with 409 CUSTOMER_EXISTS", async () => {
    stub.customer.findFirst.mockResolvedValue(CUSTOMER_ROW);

    await expect(
      createCustomer(STORE_ID, undefined, { name: "Other", email: "ade@example.com" }),
    ).rejects.toMatchObject({ code: "CUSTOMER_EXISTS", statusCode: 409 });
    expect(stub.customer.create).not.toHaveBeenCalled();
  });

  it("lowercases the email and rejects invalid input", async () => {
    stub.customer.create.mockResolvedValue(CUSTOMER_ROW);

    await createCustomer(STORE_ID, undefined, { name: "Ade", email: "ADE@EXAMPLE.COM" });
    const call = stub.customer.create.mock.calls[0]![0] as { data: { email: string } };
    expect(call.data.email).toBe("ade@example.com");

    await expect(createCustomer(STORE_ID, undefined, { name: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("getCustomerDetail (unit)", () => {
  it("returns the credit state, repayment timeline, and recent orders", async () => {
    stub.customer.findFirst.mockResolvedValue(CUSTOMER_ROW);
    stub.order.findMany.mockResolvedValue([{ total: D("5000.00"), amountPaid: D("4500.00") }]);
    stub.creditRepayment.findMany.mockResolvedValue([
      {
        id: "repayment-1",
        orderId: "order-1",
        amount: D("500.00"),
        note: "Part payment",
        createdAt: new Date("2026-08-12T12:00:00.000Z"),
        recordedByStaff: {
          account: { firstName: "Chidi", lastName: "Manager", email: "chidi@example.com" },
        },
      },
    ]);
    ordersMocks.listOrders.mockResolvedValue({
      items: [
        {
          id: "order-1",
          status: "PAID",
          paymentMethod: "CREDIT",
          source: "POS",
          total: "1250.00",
          discountAmount: "0.00",
          amountPaid: "750.00",
          balanceDue: "500.00",
          itemCount: 2,
          customer: CUSTOMER_ROW,
          branch: { id: "b-1", name: "Main Branch" },
          soldBy: null,
          createdAt: new Date("2026-08-12T10:00:00.000Z"),
        },
      ],
      nextCursor: null,
    });

    const result = await getCustomerDetail(STORE_ID, CUSTOMER_ID);

    expect(result.customer.openCredit).toBe("500.00");
    expect(result.customer.hasOutstandingCredit).toBe(true);
    expect(result.repayments).toEqual([
      {
        id: "repayment-1",
        orderId: "order-1",
        amount: "500.00",
        note: "Part payment",
        recordedByName: "Chidi Manager",
        createdAt: new Date("2026-08-12T12:00:00.000Z"),
      },
    ]);
    expect(result.recentOrders).toEqual([
      {
        id: "order-1",
        status: "PAID",
        paymentMethod: "CREDIT",
        source: "POS",
        total: "1250.00",
        amountPaid: "750.00",
        balanceDue: "500.00",
        createdAt: new Date("2026-08-12T10:00:00.000Z"),
      },
    ]);
    expect(ordersMocks.listOrders).toHaveBeenCalledWith(STORE_ID, {
      customerId: CUSTOMER_ID,
      limit: 10,
    });
  });

  it("rejects an unknown customer with 404 CUSTOMER_NOT_FOUND", async () => {
    stub.customer.findFirst.mockResolvedValue(null);

    await expect(getCustomerDetail(STORE_ID, CUSTOMER_ID)).rejects.toMatchObject({
      code: "CUSTOMER_NOT_FOUND",
      statusCode: 404,
    });
  });
});

describe("updateCustomer (unit)", () => {
  it("updates provided fields and logs customer.updated", async () => {
    stub.customer.findFirst.mockResolvedValue(CUSTOMER_ROW);
    stub.customer.update.mockResolvedValue({ ...CUSTOMER_ROW, name: "Ade O. Jr" });
    stub.order.findMany.mockResolvedValue([]);

    const result = await updateCustomer(STORE_ID, undefined, CUSTOMER_ID, {
      name: "Ade O. Jr",
    });

    expect(result.name).toBe("Ade O. Jr");
    expect(stub.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CUSTOMER_ID }, data: { name: "Ade O. Jr" } }),
    );
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "customer.updated" }),
    );
  });

  it("clears phone/email when null is passed explicitly", async () => {
    stub.customer.findFirst.mockResolvedValue(CUSTOMER_ROW);
    stub.customer.update.mockResolvedValue(CUSTOMER_ROW);
    stub.order.findMany.mockResolvedValue([]);

    await updateCustomer(STORE_ID, undefined, CUSTOMER_ID, { phone: null });

    const call = stub.customer.update.mock.calls[0]![0] as { data: { phone: string | null } };
    expect(call.data.phone).toBeNull();
  });

  it("rejects an empty body and a conflicting email", async () => {
    stub.customer.findFirst.mockResolvedValue(CUSTOMER_ROW);

    await expect(updateCustomer(STORE_ID, undefined, CUSTOMER_ID, {})).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });

    stub.customer.findFirst
      .mockResolvedValueOnce(CUSTOMER_ROW)
      .mockResolvedValueOnce({ id: "other" });
    await expect(
      updateCustomer(STORE_ID, undefined, CUSTOMER_ID, { email: "taken@example.com" }),
    ).rejects.toMatchObject({ code: "CUSTOMER_EXISTS", statusCode: 409 });
    expect(stub.customer.update).not.toHaveBeenCalled();
  });
});

describe("deleteCustomer (unit)", () => {
  it("deletes a record-less customer and logs customer.deleted", async () => {
    stub.customer.findFirst.mockResolvedValue(CUSTOMER_ROW);
    stub.customer.delete.mockResolvedValue(CUSTOMER_ROW);

    await deleteCustomer(STORE_ID, undefined, CUSTOMER_ID);

    expect(stub.customer.delete).toHaveBeenCalledWith({ where: { id: CUSTOMER_ID } });
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "customer.deleted" }),
    );
  });

  it("surfaces the Restrict guard as 409 CUSTOMER_HAS_RECORDS", async () => {
    stub.customer.findFirst.mockResolvedValue(CUSTOMER_ROW);
    stub.customer.delete.mockRejectedValue(
      Object.assign(new Error("FK"), {
        code: "P2039",
        meta: {
          driverAdapterError: { cause: { originalCode: "23001" } },
        },
      }),
    );

    await expect(deleteCustomer(STORE_ID, undefined, CUSTOMER_ID)).rejects.toMatchObject({
      code: "CUSTOMER_HAS_RECORDS",
      statusCode: 409,
    });
  });

  it("rejects an unknown customer with 404", async () => {
    stub.customer.findFirst.mockResolvedValue(null);

    await expect(deleteCustomer(STORE_ID, undefined, CUSTOMER_ID)).rejects.toMatchObject({
      code: "CUSTOMER_NOT_FOUND",
      statusCode: 404,
    });
  });
});

describe("recordCreditRepayment (unit)", () => {
  function openOrderRows() {
    stub.order.findMany.mockResolvedValue([
      { id: "order-1", total: D("1500.00"), amountPaid: D("500.00") },
      { id: "order-2", total: D("2000.00"), amountPaid: D("0.00") },
    ]);
  }

  it("distributes oldest-first across open credit orders", async () => {
    stub.customer.findFirst.mockResolvedValue(CUSTOMER_ROW);
    openOrderRows();
    stub.order.update.mockResolvedValue({});
    stub.creditRepayment.create.mockResolvedValue({});

    const result = await recordCreditRepayment(STORE_ID, STAFF_ID, CUSTOMER_ID, {
      amount: "2500.00",
      note: "Settlement",
    });

    expect(result).toEqual({
      allocated: [
        { orderId: "order-1", amount: "1000.00" },
        { orderId: "order-2", amount: "1500.00" },
      ],
      remaining: "0.00",
      totalOutstanding: "3000.00",
    });
    // order-1 balance 1000.00 fully paid, then 1500.00 of order-2's 2000.00.
    expect(stub.order.update).toHaveBeenNthCalledWith(1, {
      where: { id: "order-1" },
      data: { amountPaid: D("1500.00") },
    });
    expect(stub.order.update).toHaveBeenNthCalledWith(2, {
      where: { id: "order-2" },
      data: { amountPaid: D("1500.00") },
    });
    expect(stub.creditRepayment.create).toHaveBeenCalledTimes(2);
    expect(stub.creditRepayment.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        storeId: STORE_ID,
        orderId: "order-1",
        amount: D("1000.00"),
        note: "Settlement",
        recordedByStaffId: STAFF_ID,
      }),
      select: { id: true },
    });
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(stub, {
      storeId: STORE_ID,
      staffMemberId: STAFF_ID,
      action: "credit.repayment.recorded",
      detail: { customerId: CUSTOMER_ID, amount: "2500.00", ordersTouched: 2 },
    });
  });

  it("accepts an exact-balance repayment", async () => {
    stub.customer.findFirst.mockResolvedValue(CUSTOMER_ROW);
    openOrderRows();
    stub.order.update.mockResolvedValue({});
    stub.creditRepayment.create.mockResolvedValue({});

    const result = await recordCreditRepayment(STORE_ID, undefined, CUSTOMER_ID, {
      amount: "3000.00",
    });

    expect(result.allocated).toEqual([
      { orderId: "order-1", amount: "1000.00" },
      { orderId: "order-2", amount: "2000.00" },
    ]);
    expect(result.remaining).toBe("0.00");
  });

  it("rejects a repayment with nothing outstanding (409 NO_OUTSTANDING_CREDIT)", async () => {
    stub.customer.findFirst.mockResolvedValue(CUSTOMER_ROW);
    stub.order.findMany.mockResolvedValue([
      { id: "order-1", total: D("500.00"), amountPaid: D("500.00") },
    ]);

    await expect(
      recordCreditRepayment(STORE_ID, undefined, CUSTOMER_ID, { amount: "10.00" }),
    ).rejects.toMatchObject({ code: "NO_OUTSTANDING_CREDIT", statusCode: 409 });
    expect(stub.order.update).not.toHaveBeenCalled();
  });

  it("rejects over-payment (409 REPAYMENT_EXCEEDS_BALANCE)", async () => {
    stub.customer.findFirst.mockResolvedValue(CUSTOMER_ROW);
    openOrderRows();

    await expect(
      recordCreditRepayment(STORE_ID, undefined, CUSTOMER_ID, { amount: "3000.01" }),
    ).rejects.toMatchObject({ code: "REPAYMENT_EXCEEDS_BALANCE", statusCode: 409 });
    expect(stub.order.update).not.toHaveBeenCalled();
  });

  it("rejects a non-positive amount and an unknown customer", async () => {
    stub.customer.findFirst.mockResolvedValue(null);
    await expect(
      recordCreditRepayment(STORE_ID, undefined, CUSTOMER_ID, { amount: "10.00" }),
    ).rejects.toMatchObject({ code: "CUSTOMER_NOT_FOUND", statusCode: 404 });

    stub.customer.findFirst.mockResolvedValue(CUSTOMER_ROW);
    stub.order.findMany.mockResolvedValue([]);
    await expect(
      recordCreditRepayment(STORE_ID, undefined, CUSTOMER_ID, { amount: "0.00" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
