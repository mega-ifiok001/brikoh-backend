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

const ledgerMocks = vi.hoisted(() => ({ recordPurchaseReceiptStockChanges: vi.fn() }));
vi.mock("../products/ledger.service.js", () => ({
  recordPurchaseReceiptStockChanges: ledgerMocks.recordPurchaseReceiptStockChanges,
}));

import { AppError } from "../../lib/AppError.js";
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  deletePurchaseOrder,
  issuePurchaseOrder,
  listPurchaseOrders,
  receivePurchaseOrder,
  recordPurchaseOrderPayment,
  updatePurchaseOrder,
} from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  $transaction: Mock;
  purchaseOrder: {
    findFirst: Mock;
    findMany: Mock;
    create: Mock;
    update: Mock;
    delete: Mock;
  };
  purchaseOrderLineItem: { findMany: Mock; update: Mock };
  purchaseOrderReceipt: { create: Mock; count: Mock };
  purchaseOrderPayment: { create: Mock };
  supplier: { findFirst: Mock };
  branch: { findFirst: Mock };
  product: { findFirst: Mock };
  productVariant: { findFirst: Mock; count: Mock };
  store: { update: Mock };
}

const STORE_ID = "c0000000-0000-4000-8000-000000000001";
const PO_ID = "c0000000-0000-4000-8000-000000000002";
const STAFF_ID = "c0000000-0000-4000-8000-000000000003";
const SUPPLIER_ID = "c0000000-0000-4000-8000-000000000004";
const BRANCH_ID = "c0000000-0000-4000-8000-000000000005";
const PRODUCT_ID = "c0000000-0000-4000-8000-000000000006";
const LINE_ID = "c0000000-0000-4000-8000-000000000007";
const D = (v: string | number) => new Prisma.Decimal(v);

const DETAIL_ROW = {
  id: PO_ID,
  number: null,
  status: "DRAFT",
  total: D("5000.00"),
  amountPaid: D("0.00"),
  notes: null,
  expectedDeliveryDate: null,
  createdAt: new Date("2026-08-14T09:00:00.000Z"),
  orderedAt: null,
  receivedAt: null,
  cancelledAt: null,
  supplier: { id: SUPPLIER_ID, name: "Prime Distributors" },
  branch: { id: BRANCH_ID, name: "Main Branch" },
  receipts: [],
  payments: [],
  _count: { lineItems: 1 },
  lineItems: [
    {
      id: LINE_ID,
      quantity: 10,
      quantityReceived: 0,
      unitCostAtOrder: D("500.00"),
      productId: PRODUCT_ID,
      variantId: null,
      product: { name: "Palm Oil 5L" },
      variant: null,
    },
  ],
};

const CREATE_INPUT = {
  supplierId: SUPPLIER_ID,
  branchId: BRANCH_ID,
  lineItems: [{ productId: PRODUCT_ID, quantity: 10, unitCostAtOrder: "500.00" }],
};

function createPrismaStub(): PrismaStub {
  return {
    $transaction: vi.fn(),
    purchaseOrder: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    purchaseOrderLineItem: { findMany: vi.fn(), update: vi.fn() },
    purchaseOrderReceipt: { create: vi.fn(), count: vi.fn() },
    purchaseOrderPayment: { create: vi.fn() },
    supplier: { findFirst: vi.fn() },
    branch: { findFirst: vi.fn() },
    product: { findFirst: vi.fn() },
    productVariant: { findFirst: vi.fn(), count: vi.fn() },
    store: { update: vi.fn() },
  };
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createPrismaStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  activityMocks.logStoreActivity.mockReset();
  activityMocks.logStoreActivity.mockResolvedValue(undefined);
  ledgerMocks.recordPurchaseReceiptStockChanges.mockReset();
  ledgerMocks.recordPurchaseReceiptStockChanges.mockResolvedValue([]);
  stub.$transaction.mockImplementation(async (fn: (tx: PrismaStub) => Promise<unknown>) =>
    fn(stub),
  );
  stub.supplier.findFirst.mockResolvedValue({ id: SUPPLIER_ID });
  stub.branch.findFirst.mockResolvedValue({ id: BRANCH_ID });
  stub.product.findFirst.mockResolvedValue({ id: PRODUCT_ID });
  stub.productVariant.count.mockResolvedValue(0);
  stub.purchaseOrder.findFirst.mockResolvedValue(DETAIL_ROW);
  stub.purchaseOrder.create.mockResolvedValue({ id: PO_ID });
  stub.purchaseOrder.update.mockResolvedValue({ id: PO_ID });
  stub.store.update.mockResolvedValue({ purchaseOrderCounter: 1 });
  stub.purchaseOrderReceipt.create.mockResolvedValue({ id: "receipt-1" });
  stub.purchaseOrderLineItem.update.mockResolvedValue({});
});

describe("createPurchaseOrder (unit)", () => {
  it("creates a DRAFT order, computing the total from captured costs", async () => {
    const result = await createPurchaseOrder(STORE_ID, STAFF_ID, CREATE_INPUT);

    expect(stub.purchaseOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: STORE_ID,
        supplierId: SUPPLIER_ID,
        branchId: BRANCH_ID,
        total: expect.any(Prisma.Decimal),
        createdByStaffId: STAFF_ID,
      }),
      select: { id: true },
    });
    const createData = (
      stub.purchaseOrder.create.mock.calls[0]![0] as { data: { total: Prisma.Decimal } }
    ).data;
    expect(createData.total.toFixed(2)).toBe("5000.00");
    expect(result.purchaseOrder.status).toBe("DRAFT");
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "purchaseOrder.created", staffMemberId: STAFF_ID }),
    );
  });

  it("404s on an unknown supplier or branch", async () => {
    stub.supplier.findFirst.mockResolvedValue(null);
    await expect(createPurchaseOrder(STORE_ID, undefined, CREATE_INPUT)).rejects.toMatchObject({
      statusCode: 404,
      code: "SUPPLIER_NOT_FOUND",
    });

    stub.supplier.findFirst.mockResolvedValue({ id: SUPPLIER_ID });
    stub.branch.findFirst.mockResolvedValue(null);
    await expect(createPurchaseOrder(STORE_ID, undefined, CREATE_INPUT)).rejects.toMatchObject({
      statusCode: 404,
      code: "BRANCH_NOT_FOUND",
    });
  });

  it("rejects a product outside the store and variant-rule violations", async () => {
    stub.product.findFirst.mockResolvedValue(null);
    await expect(createPurchaseOrder(STORE_ID, undefined, CREATE_INPUT)).rejects.toMatchObject({
      statusCode: 404,
      code: "PRODUCT_NOT_FOUND",
    });

    stub.product.findFirst.mockResolvedValue({ id: PRODUCT_ID });
    stub.productVariant.count.mockResolvedValue(2);
    await expect(createPurchaseOrder(STORE_ID, undefined, CREATE_INPUT)).rejects.toMatchObject({
      statusCode: 400,
      code: "VARIANT_REQUIRED",
    });

    stub.productVariant.count.mockResolvedValue(0);
    stub.productVariant.findFirst.mockResolvedValue(null);
    await expect(
      createPurchaseOrder(STORE_ID, undefined, {
        ...CREATE_INPUT,
        lineItems: [
          {
            productId: PRODUCT_ID,
            variantId: "c0000000-0000-4000-8000-00000000000a",
            quantity: 1,
            unitCostAtOrder: "10.00",
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "VARIANT_NOT_FOUND" });
  });

  it("rejects empty lineItems and empty orders", async () => {
    await expect(
      createPurchaseOrder(STORE_ID, undefined, { ...CREATE_INPUT, lineItems: [] }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe("updatePurchaseOrder (unit)", () => {
  it("rejects a non-DRAFT order", async () => {
    stub.purchaseOrder.findFirst.mockResolvedValue({ ...DETAIL_ROW, status: "ORDERED" });

    await expect(
      updatePurchaseOrder(STORE_ID, undefined, PO_ID, CREATE_INPUT),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "ORDER_NOT_EDITABLE",
    });
  });

  it("replaces line items and recomputes the total for a DRAFT", async () => {
    stub.purchaseOrder.update.mockResolvedValue({ id: PO_ID });

    await updatePurchaseOrder(STORE_ID, undefined, PO_ID, {
      ...CREATE_INPUT,
      lineItems: [{ productId: PRODUCT_ID, quantity: 3, unitCostAtOrder: "400.00" }],
    });

    const updateData = (
      stub.purchaseOrder.update.mock.calls[0]![0] as { data: { total: Prisma.Decimal } }
    ).data;
    expect(updateData.total.toFixed(2)).toBe("1200.00");
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "purchaseOrder.updated" }),
    );
  });
});

describe("deletePurchaseOrder (unit)", () => {
  it("rejects a non-DRAFT order", async () => {
    stub.purchaseOrder.findFirst.mockResolvedValue({ ...DETAIL_ROW, status: "RECEIVED" });

    await expect(deletePurchaseOrder(STORE_ID, undefined, PO_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: "ORDER_NOT_EDITABLE",
    });
  });

  it("deletes a DRAFT order", async () => {
    await deletePurchaseOrder(STORE_ID, undefined, PO_ID);

    expect(stub.purchaseOrder.delete).toHaveBeenCalledWith({ where: { id: PO_ID } });
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "purchaseOrder.deleted" }),
    );
  });
});

describe("issuePurchaseOrder (unit)", () => {
  it("assigns the sequential PO number and stamps orderedAt", async () => {
    stub.purchaseOrder.update.mockResolvedValue({ id: PO_ID });

    const result = await issuePurchaseOrder(STORE_ID, undefined, PO_ID);

    expect(stub.store.update).toHaveBeenCalledWith({
      where: { id: STORE_ID },
      data: { purchaseOrderCounter: { increment: 1 } },
      select: { purchaseOrderCounter: true },
    });
    const updateData = (
      stub.purchaseOrder.update.mock.calls[0]![0] as {
        data: { status: string; number: string };
      }
    ).data;
    expect(updateData).toMatchObject({ status: "ORDERED", number: "PO-0001" });
    expect(updateData).toHaveProperty("orderedAt");
    expect(result.purchaseOrder.number).toBeNull();
  });

  it("rejects a non-DRAFT order", async () => {
    stub.purchaseOrder.findFirst.mockResolvedValue({ ...DETAIL_ROW, status: "ORDERED" });

    await expect(issuePurchaseOrder(STORE_ID, undefined, PO_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: "ORDER_NOT_EDITABLE",
    });
  });
});

describe("cancelPurchaseOrder (unit)", () => {
  it("cancels a DRAFT/ORDERED order with no receipts", async () => {
    stub.purchaseOrderReceipt.count.mockResolvedValue(0);

    await cancelPurchaseOrder(STORE_ID, undefined, PO_ID);

    const updateData = (
      stub.purchaseOrder.update.mock.calls[0]![0] as {
        data: { status: string };
      }
    ).data;
    expect(updateData.status).toBe("CANCELLED");
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "purchaseOrder.cancelled" }),
    );
  });

  it("refuses when receipts exist", async () => {
    stub.purchaseOrderReceipt.count.mockResolvedValue(1);

    await expect(cancelPurchaseOrder(STORE_ID, undefined, PO_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: "ORDER_NOT_CANCELLABLE",
    });
  });

  it("refuses a RECEIVED order", async () => {
    stub.purchaseOrder.findFirst.mockResolvedValue({ ...DETAIL_ROW, status: "RECEIVED" });

    await expect(cancelPurchaseOrder(STORE_ID, undefined, PO_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: "ORDER_NOT_CANCELLABLE",
    });
  });
});

describe("receivePurchaseOrder (unit)", () => {
  const RECEIVABLE_ROW = {
    id: PO_ID,
    status: "ORDERED",
    branchId: BRANCH_ID,
  };

  beforeEach(() => {
    stub.purchaseOrder.findFirst
      .mockResolvedValueOnce(RECEIVABLE_ROW)
      .mockResolvedValue(DETAIL_ROW);
    stub.purchaseOrderLineItem.findMany.mockResolvedValue([
      {
        id: LINE_ID,
        productId: PRODUCT_ID,
        variantId: null,
        quantity: 10,
        quantityReceived: 0,
        unitCostAtOrder: D("500.00"),
      },
    ]);
  });

  it("records the receipt, moves stock, and reaches RECEIVED when fully in", async () => {
    await receivePurchaseOrder(STORE_ID, STAFF_ID, PO_ID, {
      lineItems: [{ lineItemId: LINE_ID, quantityReceived: 10 }],
    });

    expect(stub.purchaseOrderReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: STORE_ID,
        purchaseOrderId: PO_ID,
        branchId: BRANCH_ID,
        recordedByStaffId: STAFF_ID,
      }),
      select: { id: true },
    });
    expect(ledgerMocks.recordPurchaseReceiptStockChanges).toHaveBeenCalledWith(stub, [
      expect.objectContaining({
        storeId: STORE_ID,
        branchId: BRANCH_ID,
        productId: PRODUCT_ID,
        quantityChange: 10,
        referenceId: PO_ID,
        performedByStaffId: STAFF_ID,
      }),
    ]);
    const updateData = (
      stub.purchaseOrder.update.mock.calls[0]![0] as {
        data: { status: string; receivedAt?: Date };
      }
    ).data;
    expect(updateData.status).toBe("RECEIVED");
    expect(updateData).toHaveProperty("receivedAt");
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "purchaseOrder.received" }),
    );
  });

  it("stays PARTIALLY_RECEIVED when some quantity remains", async () => {
    await receivePurchaseOrder(STORE_ID, STAFF_ID, PO_ID, {
      lineItems: [{ lineItemId: LINE_ID, quantityReceived: 4 }],
    });

    const updateData = (
      stub.purchaseOrder.update.mock.calls[0]![0] as {
        data: { status: string };
      }
    ).data;
    expect(updateData).toMatchObject({ status: "PARTIALLY_RECEIVED" });
    expect(updateData).not.toHaveProperty("receivedAt");
  });

  it("rejects over-receipt and unknown line items", async () => {
    stub.purchaseOrder.findFirst
      .mockResolvedValueOnce(RECEIVABLE_ROW)
      .mockResolvedValue(RECEIVABLE_ROW);
    await expect(
      receivePurchaseOrder(STORE_ID, undefined, PO_ID, {
        lineItems: [{ lineItemId: LINE_ID, quantityReceived: 11 }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });

    await expect(
      receivePurchaseOrder(STORE_ID, undefined, PO_ID, {
        lineItems: [{ lineItemId: "c0000000-0000-4000-8000-00000000000b", quantityReceived: 1 }],
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "LINE_ITEM_NOT_FOUND" });
    expect(stub.purchaseOrderReceipt.create).not.toHaveBeenCalled();
  });

  it("rejects receiving on a DRAFT order", async () => {
    stub.purchaseOrder.findFirst
      .mockReset()
      .mockResolvedValueOnce({ ...RECEIVABLE_ROW, status: "DRAFT" });

    await expect(
      receivePurchaseOrder(STORE_ID, undefined, PO_ID, {
        lineItems: [{ lineItemId: LINE_ID, quantityReceived: 1 }],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_RECEIVABLE" });
  });
});

describe("recordPurchaseOrderPayment (unit)", () => {
  const PAYABLE_ROW = {
    id: PO_ID,
    status: "ORDERED",
    total: D("7500.00"),
    amountPaid: D("3000.00"),
  };

  beforeEach(() => {
    stub.purchaseOrder.findFirst.mockResolvedValue(PAYABLE_ROW);
    stub.purchaseOrderPayment.create.mockResolvedValue({ id: "payment-1" });
  });

  it("records the payment and returns the new balance", async () => {
    const result = await recordPurchaseOrderPayment(STORE_ID, undefined, PO_ID, {
      amount: "2000.00",
    });

    expect(result).toEqual({ amount: "2000.00", allocated: "2000.00", balanceDue: "2500.00" });
    expect(stub.purchaseOrderPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ purchaseOrderId: PO_ID, amount: expect.any(Prisma.Decimal) }),
    });
    expect(stub.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: PO_ID },
      data: { amountPaid: { increment: expect.any(Prisma.Decimal) } },
    });
  });

  it("rejects a payment above the outstanding balance", async () => {
    await expect(
      recordPurchaseOrderPayment(STORE_ID, undefined, PO_ID, { amount: "5000.00" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "PAYMENT_EXCEEDS_BALANCE" });
  });

  it("rejects payments on DRAFT/CANCELLED orders", async () => {
    stub.purchaseOrder.findFirst.mockResolvedValue({ ...PAYABLE_ROW, status: "DRAFT" });
    await expect(
      recordPurchaseOrderPayment(STORE_ID, undefined, PO_ID, { amount: "100.00" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_PAYABLE" });

    stub.purchaseOrder.findFirst.mockResolvedValue({ ...PAYABLE_ROW, status: "CANCELLED" });
    await expect(
      recordPurchaseOrderPayment(STORE_ID, undefined, PO_ID, { amount: "100.00" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_NOT_PAYABLE" });
  });
});

describe("listPurchaseOrders (unit)", () => {
  it("filters, paginates, and serializes money", async () => {
    stub.purchaseOrder.findMany.mockResolvedValue([
      { ...DETAIL_ROW, id: "po-2", status: "ORDERED", number: "PO-0001", orderedAt: new Date() },
    ]);

    const result = await listPurchaseOrders(STORE_ID, { status: "ORDERED", limit: 20 });

    expect(stub.purchaseOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ storeId: STORE_ID, status: "ORDERED" }),
        take: 21,
      }),
    );
    expect(result.items[0]).toMatchObject({
      number: "PO-0001",
      total: "5000.00",
      balanceDue: "5000.00",
      supplier: { id: SUPPLIER_ID },
    });
    expect(result.nextCursor).toBeNull();
  });

  it("returns a nextCursor when more rows exist", async () => {
    stub.purchaseOrder.findMany.mockResolvedValue([
      { ...DETAIL_ROW, id: "po-1" },
      { ...DETAIL_ROW, id: "po-2" },
    ]);

    const result = await listPurchaseOrders(STORE_ID, { limit: 1 });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe("po-1");
  });
});
