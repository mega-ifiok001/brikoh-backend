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

import { getPublicInvoice, setInvoiceLinkEnabled } from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  $transaction: Mock;
  invoice: { findFirst: Mock; update: Mock };
  bankAccount: { findFirst: Mock };
}

const INVOICE_ID = "c0000000-0000-4000-8000-000000000002";
const CUSTOMER_ID = "c0000000-0000-4000-8000-000000000004";
const PRODUCT_ID = "c0000000-0000-4000-8000-000000000005";
const STORE_ID = "c0000000-0000-4000-8000-000000000001";
const D = (v: string | number) => new Prisma.Decimal(v);

/**
 * An ISSUED invoice row as the public read selects it: the store is
 * joined for the header, the customer for the greeting, and the line
 * items for the itemisation. Payments are NEVER selected — the public
 * view shows only the aggregate balance.
 */
const ISSUED_ROW = {
  id: INVOICE_ID,
  storeId: STORE_ID,
  number: "INV-0001",
  status: "ISSUED",
  linkEnabled: true,
  total: D("1250.00"),
  amountPaid: D("250.00"),
  dueDate: new Date("2026-09-01T00:00:00.000Z"),
  issuedAt: new Date("2026-08-13T10:05:00.000Z"),
  store: { name: "Mama Ade Stores", currency: "NGN" },
  customer: { id: CUSTOMER_ID, name: "Ade Okafor" },
  lineItems: [
    {
      id: "line-1",
      quantity: 2,
      unitPriceAtIssue: D("550.00"),
      product: { id: PRODUCT_ID, name: "Palm Oil 5L" },
    },
    {
      id: "line-2",
      quantity: 1,
      unitPriceAtIssue: D("150.00"),
      product: { id: PRODUCT_ID, name: "Rice 1kg" },
    },
  ],
};

const BANK_ROW = {
  bankName: "Access Bank",
  accountName: "Adebayo Idowu",
  accountNumber: "0123456789",
};

/** Dashboard detail shape (invoiceRow select) — needs payments + lineItems. */
const DETAIL_ROW = {
  id: INVOICE_ID,
  number: "INV-0001",
  status: "ISSUED",
  linkEnabled: true,
  total: D("1250.00"),
  amountPaid: D("250.00"),
  dueDate: new Date("2026-09-01T00:00:00.000Z"),
  createdAt: new Date("2026-08-13T10:00:00.000Z"),
  issuedAt: new Date("2026-08-13T10:05:00.000Z"),
  customer: { id: CUSTOMER_ID, name: "Ade Okafor", phone: "+2348012345678" },
  payments: [
    {
      id: "payment-1",
      amount: D("250.00"),
      note: null,
      recordedByStaff: null,
      createdAt: new Date("2026-08-14T09:00:00.000Z"),
    },
  ],
  lineItems: [
    {
      id: "line-1",
      quantity: 2,
      unitPriceAtIssue: D("550.00"),
      product: { id: PRODUCT_ID, name: "Palm Oil 5L" },
    },
  ],
};

let stub: PrismaStub;

beforeEach(() => {
  stub = {
    $transaction: vi.fn(),
    invoice: { findFirst: vi.fn(), update: vi.fn() },
    bankAccount: { findFirst: vi.fn() },
  };
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  activityMocks.logStoreActivity.mockReset();
  activityMocks.logStoreActivity.mockResolvedValue(undefined);
  stub.invoice.update.mockResolvedValue({ id: INVOICE_ID });
  stub.$transaction.mockImplementation(async (fn: (tx: PrismaStub) => Promise<unknown>) =>
    fn(stub),
  );
});

describe("getPublicInvoice (unit)", () => {
  it("returns the invoice, its items, and the store's bank details when ISSUED", async () => {
    stub.invoice.findFirst.mockResolvedValue(ISSUED_ROW);
    stub.bankAccount.findFirst.mockResolvedValue(BANK_ROW);

    const view = await getPublicInvoice(INVOICE_ID);

    expect(view).toMatchObject({
      id: INVOICE_ID,
      number: "INV-0001",
      status: "ISSUED",
      storeName: "Mama Ade Stores",
      currency: "NGN",
      customerName: "Ade Okafor",
      total: "1250.00",
      amountPaid: "250.00",
      balanceDue: "1000.00",
      isPayable: true,
      bankDetails: {
        bankName: "Access Bank",
        accountName: "Adebayo Idowu",
        accountNumber: "0123456789",
      },
    });
    expect(view.lineItems).toEqual([
      {
        id: "line-1",
        productName: "Palm Oil 5L",
        quantity: 2,
        unitPrice: "550.00",
        lineTotal: "1100.00",
      },
      {
        id: "line-2",
        productName: "Rice 1kg",
        quantity: 1,
        unitPrice: "150.00",
        lineTotal: "150.00",
      },
    ]);
  });

  it("never exposes the payment ledger, customer contact, or internal ids", async () => {
    stub.invoice.findFirst.mockResolvedValue(ISSUED_ROW);
    stub.bankAccount.findFirst.mockResolvedValue(BANK_ROW);

    const view = await getPublicInvoice(INVOICE_ID);

    expect(view).not.toHaveProperty("payments");
    expect(view).not.toHaveProperty("storeId");
    expect(view).not.toHaveProperty("customerId");
    expect(JSON.stringify(view)).not.toContain(CUSTOMER_ID);
    expect(JSON.stringify(view)).not.toContain(STORE_ID);
  });

  it("hides bank details and marks not payable once PAID", async () => {
    stub.invoice.findFirst.mockResolvedValue({
      ...ISSUED_ROW,
      status: "PAID",
      amountPaid: D("1250.00"),
    });

    const view = await getPublicInvoice(INVOICE_ID);

    expect(view.status).toBe("PAID");
    expect(view.balanceDue).toBe("0.00");
    expect(view.isPayable).toBe(false);
    expect(view.bankDetails).toBeNull();
    // A settled invoice must never trigger a bank lookup.
    expect(stub.bankAccount.findFirst).not.toHaveBeenCalled();
  });

  it("hides bank details and marks not payable once VOID", async () => {
    stub.invoice.findFirst.mockResolvedValue({ ...ISSUED_ROW, status: "VOID" });

    const view = await getPublicInvoice(INVOICE_ID);

    expect(view.status).toBe("VOID");
    expect(view.isPayable).toBe(false);
    expect(view.bankDetails).toBeNull();
    expect(stub.bankAccount.findFirst).not.toHaveBeenCalled();
  });

  it("404s a DRAFT invoice — an unissued invoice is not shareable", async () => {
    stub.invoice.findFirst.mockResolvedValue({ ...ISSUED_ROW, status: "DRAFT", number: null });

    await expect(getPublicInvoice(INVOICE_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "INVOICE_NOT_FOUND",
    });
  });

  it("404s an unknown invoice id", async () => {
    stub.invoice.findFirst.mockResolvedValue(null);

    await expect(getPublicInvoice(INVOICE_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "INVOICE_NOT_FOUND",
    });
  });

  it("returns null bank details when the store has not configured an account", async () => {
    stub.invoice.findFirst.mockResolvedValue(ISSUED_ROW);
    stub.bankAccount.findFirst.mockResolvedValue(null);

    const view = await getPublicInvoice(INVOICE_ID);

    expect(view.isPayable).toBe(true);
    expect(view.bankDetails).toBeNull();
  });

  it("reads the store's default bank account, scoped to the invoice's store", async () => {
    stub.invoice.findFirst.mockResolvedValue(ISSUED_ROW);
    stub.bankAccount.findFirst.mockResolvedValue(BANK_ROW);

    await getPublicInvoice(INVOICE_ID);

    expect(stub.bankAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: STORE_ID, isDefault: true, accountNumber: { not: null } },
      }),
    );
  });

  it("404s an issued invoice whose link the merchant disabled", async () => {
    stub.invoice.findFirst.mockResolvedValue({ ...ISSUED_ROW, linkEnabled: false });

    await expect(getPublicInvoice(INVOICE_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "INVOICE_NOT_FOUND",
    });
    // A disabled link must not even trigger a bank lookup.
    expect(stub.bankAccount.findFirst).not.toHaveBeenCalled();
  });
});

describe("setInvoiceLinkEnabled (unit)", () => {
  it("disables the link on an issued invoice and logs activity", async () => {
    stub.invoice.findFirst
      .mockResolvedValueOnce({ id: INVOICE_ID, status: "ISSUED" })
      .mockResolvedValue(DETAIL_ROW);

    await setInvoiceLinkEnabled(STORE_ID, undefined, INVOICE_ID, false);

    expect(stub.invoice.update).toHaveBeenCalledWith({
      where: { id: INVOICE_ID },
      data: { linkEnabled: false },
    });
    expect(activityMocks.logStoreActivity).toHaveBeenCalledWith(
      stub,
      expect.objectContaining({ action: "invoice.link.disabled", detail: { invoiceId: INVOICE_ID } }),
    );
  });

  it("enables the link on an issued invoice", async () => {
    stub.invoice.findFirst
      .mockResolvedValueOnce({ id: INVOICE_ID, status: "ISSUED" })
      .mockResolvedValue(DETAIL_ROW);

    const detail = await setInvoiceLinkEnabled(STORE_ID, undefined, INVOICE_ID, true);

    expect(stub.invoice.update).toHaveBeenCalledWith({
      where: { id: INVOICE_ID },
      data: { linkEnabled: true },
    });
    expect(detail.invoice.linkEnabled).toBe(true);
  });

  it("404s an unknown invoice", async () => {
    stub.invoice.findFirst.mockResolvedValue(null);

    await expect(setInvoiceLinkEnabled(STORE_ID, undefined, INVOICE_ID, false)).rejects.toMatchObject(
      { statusCode: 404, code: "INVOICE_NOT_FOUND" },
    );
    expect(stub.invoice.update).not.toHaveBeenCalled();
  });

  it("rejects toggling the link on a DRAFT invoice", async () => {
    stub.invoice.findFirst.mockResolvedValue({ id: INVOICE_ID, status: "DRAFT" });

    await expect(setInvoiceLinkEnabled(STORE_ID, undefined, INVOICE_ID, false)).rejects.toMatchObject(
      { statusCode: 409, code: "INVOICE_NOT_ISSUED" },
    );
    expect(stub.invoice.update).not.toHaveBeenCalled();
  });
});
