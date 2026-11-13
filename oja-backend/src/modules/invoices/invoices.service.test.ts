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

import {
  createInvoice,
  deleteInvoice,
  getInvoiceDetail,
  issueInvoice,
  listInvoices,
  recordInvoicePayment,
  updateInvoice,
  voidInvoice,
} from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  $transaction: Mock;
  invoice: { findFirst: Mock; findMany: Mock; create: Mock; update: Mock; delete: Mock };
  invoicePayment: { count: Mock; create: Mock };
  customer: { findFirst: Mock };
  product: { findMany: Mock };
  store: { update: Mock };
}

const STORE_ID = "c0000000-0000-4000-8000-000000000001";
const INVOICE_ID = "c0000000-0000-4000-8000-000000000002";
const STAFF_ID = "c0000000-0000-4000-8000-000000000003";
const CUSTOMER_ID = "c0000000-0000-4000-8000-000000000004";
const PRODUCT_ID = "c0000000-0000-4000-8000-000000000005";
const D = (v: string | number) => new Prisma.Decimal(v);

const INVOICE_ROW = {
  id: INVOICE_ID,
  number: null,
  status: "DRAFT",
  total: D("1250.00"),
  amountPaid: D("0.00"),
  dueDate: null,
  createdAt: new Date("2026-08-13T10:00:00.000Z"),
  issuedAt: null,
  customer: { id: CUSTOMER_ID, name: "Ade Okafor", phone: "+2348012345678" },
  payments: [],
  lineItems: [
    {
      id: "line-1",
      quantity: 2,
      unitPriceAtIssue: D("550.00"),
      product: { id: PRODUCT_ID, name: "Palm Oil 5L" },
    },
  ],
};

function createPrismaStub(): PrismaStub {
  return {
    $transaction: vi.fn(),
    invoice: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    invoicePayment: { count: vi.fn(), create: vi.fn() },
    customer: { findFirst: vi.fn() },
    product: { findMany: vi.fn() },
    store: { update: vi.fn() },
  };
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createPrismaStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  activityMocks.logStoreActivity.mockReset();
  activityMocks.logStoreActivity.mockResolvedValue(undefined);
  stub.$transaction.mockImplementation(async (fn: (tx: PrismaStub) => Promise<unknown>) =>
    fn(stub),
  );
});

describe("listInvoices (unit)", () => {
  it("pages newest-first with balance, item count, and nextCursor", async () => {
    stub.invoice.findMany.mockResolvedValue([
      {
        ...INVOICE_ROW,
        id: "invoice-2",
        number: "INV-0002",
        status: "ISSUED",
        amountPaid: D("750.00"),
        issuedAt: new Date("2026-08-13T10:05:00.000Z"),
        lineItems: [{ quantity: 2 }, { quantity: 1 }],
      },
      INVOICE_ROW,
    ]);

    const result = await listInvoices(STORE_ID, { limit: 20 });

    expect(result.items[0]).toEqual({
      id: "invoice-2",
      number: "INV-0002",
      status: "ISSUED",
      total: "1250.00",
      amountPaid: "750.00",
      balanceDue: "500.00",
      dueDate: null,
      itemCount: 3,
      customer: { id: CUSTOMER_ID, name: "Ade Okafor", phone: "+2348012345678" },
      createdAt: INVOICE_ROW.createdAt,
      issuedAt: new Date("2026-08-13T10:05:00.000Z"),
    });
    expect(result.items[1]!.number).toBeNull();
    expect(result.items[1]!.balanceDue).toBe("1250.00");
    expect(stub.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 20,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
  });

  it("applies status, customerId, and q filters plus the cursor", async () => {
    stub.invoice.findMany.mockResolvedValue([]);

    await listInvoices(STORE_ID, {
      status: "PAID",
      customerId: CUSTOMER_ID,
      q: "okafor",
      cursor: "c0000000-0000-4000-8000-000000000001",
      limit: 5,
    });

    const call = stub.invoice.findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(call.where).toMatchObject({
      storeId: STORE_ID,
      status: "PAID",
      customerId: CUSTOMER_ID,
      id: { lt: "c0000000-0000-4000-8000-000000000001" },
      customer: {
        OR: [
          { name: { contains: "okafor", mode: "insensitive" } },
          { phone: { contains: "okafor", mode: "insensitive" } },
        ],
      },
    });
  });

  it("reports nextCursor only on a full page", async () => {
    stub.invoice.findMany.mockResolvedValue([INVOICE_ROW, INVOICE_ROW]);
    const full = await listInvoices(STORE_ID, { limit: 2 });
    expect(full.nextCursor).toBe(INVOICE_ID);

    stub.invoice.findMany.mockResolvedValue([INVOICE_ROW]);
    const partial = await listInvoices(STORE_ID, { limit: 2 });
    expect(partial.nextCursor).toBeNull();
  });
});

describe("createInvoice (unit)", () => {
  function createSetup() {
    stub.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
    stub.product.findMany.mockResolvedValue([{ id: PRODUCT_ID }]);
    stub.invoice.create.mockResolvedValue({ id: INVOICE_ID });
    stub.invoice.findFirst.mockResolvedValue(INVOICE_ROW);
  }

  it("creates a DRAFT with computed total and logs invoice.created", async () => {
    createSetup();

    const result = await createInvoice(STORE_ID, STAFF_ID, {
      customerId: CUSTOMER_ID,
      dueDate: "2026-09-01T00:00:00.000Z",
      lineItems: [
        { productId: PRODUCT_ID, quantity: 2, unitPriceAtIssue: "550.00" },
        { productId: PRODUCT_ID, quantity: 1, unitPriceAtIssue: "150.00" },
      ],
    });

    expect(result.invoice).toMatchObject({ status: "DRAFT", total: "1250.00", number: null });
    const createCall = stub.invoice.create.mock.calls[0]![0] as {
      data: { total: Prisma.Decimal; lineItems: { create: unknown[] } };
    };
    expect(createCall.data.total.toFixed(2)).toBe("1250.00");
    expect(createCall.data.lineItems.create).toHaveLength(2);
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(stub, {
      storeId: STORE_ID,
      staffMemberId: STAFF_ID,
      action: "invoice.created",
      detail: { invoiceId: INVOICE_ID },
    });
  });

  it("rejects an unknown customer (404) and a cross-store product (404)", async () => {
    stub.customer.findFirst.mockResolvedValue(null);
    await expect(
      createInvoice(STORE_ID, undefined, {
        customerId: CUSTOMER_ID,
        lineItems: [{ productId: PRODUCT_ID, quantity: 1, unitPriceAtIssue: "10.00" }],
      }),
    ).rejects.toMatchObject({ code: "CUSTOMER_NOT_FOUND", statusCode: 404 });

    stub.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
    stub.product.findMany.mockResolvedValue([{ id: PRODUCT_ID }]);
    await expect(
      createInvoice(STORE_ID, undefined, {
        customerId: CUSTOMER_ID,
        lineItems: [
          { productId: PRODUCT_ID, quantity: 1, unitPriceAtIssue: "10.00" },
          {
            productId: "c0000000-0000-4000-8000-000000000099",
            quantity: 1,
            unitPriceAtIssue: "10.00",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND", statusCode: 404 });
    expect(stub.invoice.create).not.toHaveBeenCalled();
  });

  it("rejects an empty lineItems array and a non-positive price", async () => {
    await expect(
      createInvoice(STORE_ID, undefined, { customerId: CUSTOMER_ID, lineItems: [] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      createInvoice(STORE_ID, undefined, {
        customerId: CUSTOMER_ID,
        lineItems: [{ productId: PRODUCT_ID, quantity: 1, unitPriceAtIssue: "0.00" }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("getInvoiceDetail (unit)", () => {
  it("formats payments with recorder names and line totals", async () => {
    stub.invoice.findFirst.mockResolvedValue({
      ...INVOICE_ROW,
      number: "INV-0001",
      status: "ISSUED",
      amountPaid: D("500.00"),
      payments: [
        {
          id: "payment-1",
          amount: D("500.00"),
          note: "First installment",
          recordedByStaff: {
            account: { firstName: "Chidi", lastName: "Manager", email: "chidi@example.com" },
          },
          createdAt: new Date("2026-08-13T12:00:00.000Z"),
        },
      ],
    });

    const result = await getInvoiceDetail(STORE_ID, INVOICE_ID);

    expect(result.invoice).toMatchObject({
      number: "INV-0001",
      status: "ISSUED",
      balanceDue: "750.00",
    });
    expect(result.payments).toEqual([
      {
        id: "payment-1",
        amount: "500.00",
        note: "First installment",
        recordedByName: "Chidi Manager",
        createdAt: new Date("2026-08-13T12:00:00.000Z"),
      },
    ]);
    expect(result.lineItems).toEqual([
      {
        id: "line-1",
        productId: PRODUCT_ID,
        productName: "Palm Oil 5L",
        quantity: 2,
        unitPriceAtIssue: "550.00",
        lineTotal: "1100.00",
      },
    ]);
  });

  it("404s an unknown invoice", async () => {
    stub.invoice.findFirst.mockResolvedValue(null);

    await expect(getInvoiceDetail(STORE_ID, INVOICE_ID)).rejects.toMatchObject({
      code: "INVOICE_NOT_FOUND",
      statusCode: 404,
    });
  });
});

describe("updateInvoice (unit)", () => {
  it("replaces line items on a DRAFT and recomputes the total", async () => {
    stub.invoice.findFirst
      .mockResolvedValueOnce({ id: INVOICE_ID, status: "DRAFT" })
      .mockResolvedValueOnce(INVOICE_ROW);
    stub.product.findMany.mockResolvedValue([{ id: PRODUCT_ID }]);
    stub.invoice.update.mockResolvedValue({ id: INVOICE_ID });

    await updateInvoice(STORE_ID, undefined, INVOICE_ID, {
      dueDate: null,
      lineItems: [{ productId: PRODUCT_ID, quantity: 3, unitPriceAtIssue: "100.00" }],
    });

    const call = stub.invoice.update.mock.calls[0]![0] as {
      data: { lineItems: { deleteMany: unknown; create: unknown[] }; dueDate: null };
    };
    expect(call.data.dueDate).toBeNull();
    expect(call.data.lineItems.deleteMany).toEqual({});
    expect(call.data.lineItems.create).toHaveLength(1);
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "invoice.updated" }),
    );
  });

  it("rejects updates to a non-DRAFT invoice (409 INVOICE_NOT_DRAFT)", async () => {
    stub.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID, status: "ISSUED" });

    await expect(
      updateInvoice(STORE_ID, undefined, INVOICE_ID, {
        lineItems: [{ productId: PRODUCT_ID, quantity: 1, unitPriceAtIssue: "10.00" }],
      }),
    ).rejects.toMatchObject({ code: "INVOICE_NOT_DRAFT", statusCode: 409 });
    expect(stub.invoice.update).not.toHaveBeenCalled();
  });
});

describe("deleteInvoice (unit)", () => {
  it("deletes a DRAFT and logs invoice.deleted", async () => {
    stub.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID, status: "DRAFT" });
    stub.invoice.delete.mockResolvedValue({});

    await deleteInvoice(STORE_ID, undefined, INVOICE_ID);

    expect(stub.invoice.delete).toHaveBeenCalledWith({ where: { id: INVOICE_ID } });
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "invoice.deleted" }),
    );
  });

  it("rejects deleting a non-DRAFT invoice", async () => {
    stub.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID, status: "ISSUED" });

    await expect(deleteInvoice(STORE_ID, undefined, INVOICE_ID)).rejects.toMatchObject({
      code: "INVOICE_NOT_DRAFT",
      statusCode: 409,
    });
    expect(stub.invoice.delete).not.toHaveBeenCalled();
  });
});

describe("issueInvoice (unit)", () => {
  it("stamps number + issuedAt and bumps the store counter atomically", async () => {
    stub.invoice.findFirst
      .mockResolvedValueOnce({ id: INVOICE_ID, status: "DRAFT" })
      .mockResolvedValueOnce({
        ...INVOICE_ROW,
        number: "INV-0007",
        status: "ISSUED",
        issuedAt: new Date(),
      });
    stub.store.update.mockResolvedValue({ invoiceCounter: 7 });
    stub.invoice.update.mockResolvedValue({ id: INVOICE_ID });

    await issueInvoice(STORE_ID, STAFF_ID, INVOICE_ID);

    expect(stub.store.update).toHaveBeenCalledWith({
      where: { id: STORE_ID },
      data: { invoiceCounter: { increment: 1 } },
      select: { invoiceCounter: true },
    });
    const call = stub.invoice.update.mock.calls[0]![0] as {
      data: { status: string; number: string; issuedAt: Date };
    };
    expect(call.data).toMatchObject({ status: "ISSUED", number: "INV-0007" });
    expect(call.data.issuedAt).toBeInstanceOf(Date);
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "invoice.issued" }),
    );
  });

  it("rejects issuing a non-DRAFT invoice", async () => {
    stub.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID, status: "PAID" });

    await expect(issueInvoice(STORE_ID, undefined, INVOICE_ID)).rejects.toMatchObject({
      code: "INVOICE_NOT_DRAFT",
      statusCode: 409,
    });
    expect(stub.store.update).not.toHaveBeenCalled();
  });
});

describe("voidInvoice (unit)", () => {
  it("voids an ISSUED invoice with no payments", async () => {
    stub.invoice.findFirst
      .mockResolvedValueOnce({ id: INVOICE_ID, status: "ISSUED" })
      .mockResolvedValueOnce({ ...INVOICE_ROW, status: "VOID" });
    stub.invoicePayment.count.mockResolvedValue(0);
    stub.invoice.update.mockResolvedValue({ id: INVOICE_ID });

    await voidInvoice(STORE_ID, undefined, INVOICE_ID);

    const call = stub.invoice.update.mock.calls[0]![0] as { data: { status: string } };
    expect(call.data.status).toBe("VOID");
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "invoice.voided" }),
    );
  });

  it("rejects voiding a non-ISSUED invoice and an invoice with payments", async () => {
    stub.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID, status: "DRAFT" });
    await expect(voidInvoice(STORE_ID, undefined, INVOICE_ID)).rejects.toMatchObject({
      code: "INVOICE_NOT_ISSUED",
      statusCode: 409,
    });

    stub.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID, status: "ISSUED" });
    stub.invoicePayment.count.mockResolvedValue(1);
    await expect(voidInvoice(STORE_ID, undefined, INVOICE_ID)).rejects.toMatchObject({
      code: "INVOICE_HAS_PAYMENTS",
      statusCode: 409,
    });
    expect(stub.invoice.update).not.toHaveBeenCalled();
  });
});

describe("recordInvoicePayment (unit)", () => {
  function issuedSetup(paid: string) {
    stub.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      status: "ISSUED",
      total: D("1000.00"),
      amountPaid: D(paid),
    });
    stub.invoicePayment.create.mockResolvedValue({ id: "payment-1" });
    stub.invoice.update.mockResolvedValue({});
  }

  it("records a partial payment and stays ISSUED", async () => {
    issuedSetup("400.00");

    const result = await recordInvoicePayment(STORE_ID, STAFF_ID, INVOICE_ID, {
      amount: "250.00",
      note: "First installment",
    });

    expect(result).toEqual({
      invoiceId: INVOICE_ID,
      status: "ISSUED",
      allocated: "250.00",
      balanceDue: "350.00",
      totalOutstanding: "600.00",
    });
    expect(stub.invoicePayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: STORE_ID,
        invoiceId: INVOICE_ID,
        amount: D("250.00"),
        note: "First installment",
        recordedByStaffId: STAFF_ID,
      }),
      select: { id: true },
    });
    const call = stub.invoice.update.mock.calls[0]![0] as {
      data: { amountPaid: Prisma.Decimal; status: string };
    };
    expect(call.data.amountPaid.toFixed(2)).toBe("650.00");
    expect(call.data.status).toBe("ISSUED");
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "invoice.payment.recorded" }),
    );
  });

  it("transitions to PAID when the balance settles", async () => {
    issuedSetup("750.00");

    const result = await recordInvoicePayment(STORE_ID, undefined, INVOICE_ID, {
      amount: "250.00",
    });

    expect(result).toMatchObject({
      status: "PAID",
      balanceDue: "0.00",
      totalOutstanding: "250.00",
    });
    const call = stub.invoice.update.mock.calls[0]![0] as { data: { status: string } };
    expect(call.data.status).toBe("PAID");
  });

  it("rejects over-payment (409 PAYMENT_EXCEEDS_BALANCE)", async () => {
    issuedSetup("400.00");

    await expect(
      recordInvoicePayment(STORE_ID, undefined, INVOICE_ID, { amount: "600.01" }),
    ).rejects.toMatchObject({ code: "PAYMENT_EXCEEDS_BALANCE", statusCode: 409 });
    expect(stub.invoicePayment.create).not.toHaveBeenCalled();
  });

  it("rejects payments on non-ISSUED invoices and invalid amounts", async () => {
    stub.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID, status: "DRAFT" });
    await expect(
      recordInvoicePayment(STORE_ID, undefined, INVOICE_ID, { amount: "10.00" }),
    ).rejects.toMatchObject({ code: "INVOICE_NOT_ISSUED", statusCode: 409 });

    stub.invoice.findFirst.mockResolvedValue({
      id: INVOICE_ID,
      status: "ISSUED",
      total: D("100.00"),
      amountPaid: D("0.00"),
    });
    await expect(
      recordInvoicePayment(STORE_ID, undefined, INVOICE_ID, { amount: "0.00" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(stub.invoicePayment.create).not.toHaveBeenCalled();
  });
});
