import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({ getPrismaClient: prismaMocks.getPrismaClient }));

import { sendCustomerReceipt, type ReceiptEmailSender } from "./service.js";

type PrismaStub = {
  store: { findUnique: Mock };
  order: { findFirst: Mock };
  invoicePayment: { findFirst: Mock };
  notificationDispatch: { findUnique: Mock; createMany: Mock };
};

const STORE_ID = "store-1";
const D = (v: string | number) => new Prisma.Decimal(v);

function storeRow(notificationSettings: unknown = null) {
  return {
    name: "Mama Ade Stores",
    businessPhone: "+2348012345678",
    location: "12 Market Road, Lagos",
    currency: "NGN",
    customDomain: null,
    subdomain: "mama-ade",
    storefrontSettings: null,
    templateSettings: null,
    owner: { account: { email: "owner@example.com" } },
    notificationSettings,
  };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    receiptEmail: "buyer@example.com",
    orderNumber: "ORD-0001",
    total: D("1250.00"),
    discountAmount: D("0.00"),
    amountPaid: D("1250.00"),
    paymentMethod: "CASH",
    deliveryFee: D("0.00"),
    createdAt: new Date("2026-09-15T10:00:00.000Z"),
    customer: { email: "buyer@example.com", name: "Ade" },
    lineItems: [
      { quantity: 2, unitPriceAtPurchase: D("550.00"), product: { name: "Palm Oil 5L" } },
    ],
    ...overrides,
  };
}

let prisma: PrismaStub;
let sender: ReceiptEmailSender & { send: Mock };

beforeEach(() => {
  prisma = {
    store: { findUnique: vi.fn() },
    order: { findFirst: vi.fn() },
    invoicePayment: { findFirst: vi.fn() },
    notificationDispatch: { findUnique: vi.fn(), createMany: vi.fn() },
  };
  prismaMocks.getPrismaClient.mockReturnValue(prisma as never);
  prisma.notificationDispatch.findUnique.mockResolvedValue(null);
  prisma.notificationDispatch.createMany.mockResolvedValue({ count: 1 });

  sender = { send: vi.fn() } as unknown as ReceiptEmailSender & { send: Mock };
  sender.send.mockResolvedValue(undefined);
});

describe("sendCustomerReceipt (unit)", () => {
  it("emails the order's receipt address and records a dispatch", async () => {
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma.order.findFirst.mockResolvedValue(orderRow());

    await sendCustomerReceipt(sender, STORE_ID, "ORDER", "order-1");

    expect(sender.send).toHaveBeenCalledTimes(1);
    const [to, email, opts] = sender.send.mock.calls[0] as [
      string,
      { subject: string },
      { fromName: string; replyTo: string | null },
    ];
    expect(to).toBe("buyer@example.com");
    expect(email.subject).toContain("ORD-0001");
    expect(opts.fromName).toBe("Mama Ade Stores");
    expect(opts.replyTo).toBe("owner@example.com");
    expect(prisma.notificationDispatch.createMany).toHaveBeenCalledTimes(1);
  });

  it("falls back to the customer email when receiptEmail is null", async () => {
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma.order.findFirst.mockResolvedValue(orderRow({ receiptEmail: null }));

    await sendCustomerReceipt(sender, STORE_ID, "ORDER", "order-1");

    expect(sender.send.mock.calls[0]?.[0]).toBe("buyer@example.com");
  });

  it("skips when the store turned receipts off", async () => {
    prisma.store.findUnique.mockResolvedValue(storeRow({ receiptsEnabled: false }));
    prisma.order.findFirst.mockResolvedValue(orderRow());

    await sendCustomerReceipt(sender, STORE_ID, "ORDER", "order-1");

    expect(sender.send).not.toHaveBeenCalled();
  });

  it("skips when there is no recipient email", async () => {
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma.order.findFirst.mockResolvedValue(
      orderRow({ receiptEmail: null, customer: { email: null, name: "Walk-in" } }),
    );

    await sendCustomerReceipt(sender, STORE_ID, "ORDER", "order-1");

    expect(sender.send).not.toHaveBeenCalled();
  });

  it("skips a receipt already dispatched (dedup)", async () => {
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma.notificationDispatch.findUnique.mockResolvedValue({ id: "dispatch-1" });

    await sendCustomerReceipt(sender, STORE_ID, "ORDER", "order-1");

    expect(sender.send).not.toHaveBeenCalled();
  });

  it("never throws when the send fails", async () => {
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma.order.findFirst.mockResolvedValue(orderRow());
    sender.send.mockRejectedValue(new Error("resend down"));

    await expect(
      sendCustomerReceipt(sender, STORE_ID, "ORDER", "order-1"),
    ).resolves.toBeUndefined();
  });

  it("sends an invoice receipt for a payment", async () => {
    prisma.store.findUnique.mockResolvedValue(storeRow());
    prisma.invoicePayment.findFirst.mockResolvedValue({
      id: "pay-1",
      amount: D("500.00"),
      createdAt: new Date("2026-09-15T10:00:00.000Z"),
      invoice: {
        number: "INV-0001",
        total: D("1250.00"),
        amountPaid: D("500.00"),
        customer: { email: "buyer@example.com", name: "Ade" },
        lineItems: [
          { quantity: 2, unitPriceAtIssue: D("550.00"), product: { name: "Palm Oil 5L" } },
        ],
      },
    });

    await sendCustomerReceipt(sender, STORE_ID, "INVOICE_PAYMENT", "pay-1");

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send.mock.calls[0]?.[0]).toBe("buyer@example.com");
    expect((sender.send.mock.calls[0]?.[1] as { subject: string }).subject).toContain("INV-0001");
  });
});
