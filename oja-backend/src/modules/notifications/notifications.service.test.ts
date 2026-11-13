import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

import {
  buildExpiringSoonAlertEmail,
  buildLowStockAlertEmail,
  buildPaymentAlertEmail,
  type AlertEmailSender,
} from "./email.js";
import {
  listDispatches,
  notifyPaymentReceived,
  sweepAlerts,
  type NotificationDispatchRow,
} from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  store: { findMany: Mock; findUnique: Mock };
  branchStock: { findMany: Mock };
  product: { findMany: Mock };
  notificationDispatch: {
    findMany: Mock;
    findUnique: Mock;
    upsert: Mock;
    createMany: Mock;
  };
  order: { findFirst: Mock };
  creditRepayment: { findFirst: Mock };
  invoicePayment: { findFirst: Mock };
}

const STORE_ID = "c0000000-0000-4000-8000-000000000001";
const OWNER_EMAIL = "owner@example.com";

function createPrismaStub(): PrismaStub {
  return {
    store: { findMany: vi.fn(), findUnique: vi.fn() },
    branchStock: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
    notificationDispatch: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      createMany: vi.fn(),
    },
    order: { findFirst: vi.fn() },
    creditRepayment: { findFirst: vi.fn() },
    invoicePayment: { findFirst: vi.fn() },
  };
}

const sender = { sendAlert: vi.fn() } as AlertEmailSender & { sendAlert: Mock };

let stub: PrismaStub;

beforeEach(() => {
  stub = createPrismaStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  sender.sendAlert.mockReset();
  sender.sendAlert.mockResolvedValue(undefined);
  stub.notificationDispatch.upsert.mockResolvedValue({});
  stub.notificationDispatch.createMany.mockResolvedValue({ count: 0 });
});

function seedStore(settings: Record<string, boolean> | null = null) {
  stub.store.findMany.mockResolvedValue([
    {
      id: STORE_ID,
      name: "Fresh Mart",
      notificationSettings: settings,
      owner: { account: { email: OWNER_EMAIL } },
    },
  ]);
}

function seedLowStockRows() {
  stub.branchStock.findMany.mockResolvedValue([
    {
      id: "bs-1",
      quantity: 3,
      branch: { name: "Main Branch" },
      product: {
        id: "p-1",
        name: "Tomatoes",
        lowStockThreshold: 5,
        deletedAt: null,
      },
    },
  ]);
}

describe("sweepAlerts (unit)", () => {
  it("sends a consolidated LOW_STOCK email and records a dispatch row", async () => {
    seedStore();
    seedLowStockRows();
    stub.notificationDispatch.findMany.mockResolvedValue([]);

    const result = await sweepAlerts(sender, new Date("2026-08-14T09:00:00.000Z"));

    expect(result).toEqual({ storesScanned: 1, emailsSent: 1 });
    expect(sender.sendAlert).toHaveBeenCalledTimes(1);
    expect(sender.sendAlert).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({ subject: "Low stock alert — Fresh Mart" }),
    );
    expect(stub.notificationDispatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId_kind_refType_refId: {
            storeId: STORE_ID,
            kind: "LOW_STOCK",
            refType: "BRANCH_STOCK",
            refId: "bs-1",
          },
        },
        create: expect.objectContaining({ sentQuantity: 3 }),
        update: expect.objectContaining({ sentQuantity: 3 }),
      }),
    );
  });

  it("never re-sends a LOW_STOCK alert at the same or better quantity", async () => {
    seedStore();
    seedLowStockRows();
    // A prior dispatch already alerted at quantity 3 (not worsened).
    stub.notificationDispatch.findMany.mockResolvedValue([{ refId: "bs-1", sentQuantity: 3 }]);

    const result = await sweepAlerts(sender);

    expect(result.emailsSent).toBe(0);
    expect(sender.sendAlert).not.toHaveBeenCalled();
    expect(stub.notificationDispatch.upsert).not.toHaveBeenCalled();
  });

  it("re-alerts when stock has WORSENED since the last dispatch", async () => {
    seedStore();
    stub.branchStock.findMany.mockResolvedValue([
      {
        id: "bs-1",
        quantity: 1,
        branch: { name: "Main Branch" },
        product: {
          id: "p-1",
          name: "Tomatoes",
          lowStockThreshold: 5,
          deletedAt: null,
        },
      },
    ]);
    // Prior dispatch at quantity 3; now at 1 — strictly worse.
    stub.notificationDispatch.findMany.mockResolvedValue([{ refId: "bs-1", sentQuantity: 3 }]);

    const result = await sweepAlerts(sender);

    expect(result.emailsSent).toBe(1);
    expect(stub.notificationDispatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ sentQuantity: 1 }),
        update: expect.objectContaining({ sentQuantity: 1 }),
      }),
    );
  });

  it("does not re-alert when a restock + re-drop lands at the prior level", async () => {
    seedStore();
    seedLowStockRows();
    // Restocked above threshold, then dropped back to 3 — the exact
    // quantity the owner was already alerted about.
    stub.notificationDispatch.findMany.mockResolvedValue([{ refId: "bs-1", sentQuantity: 3 }]);

    const result = await sweepAlerts(sender);

    expect(result.emailsSent).toBe(0);
    expect(sender.sendAlert).not.toHaveBeenCalled();
  });

  it("sends EXPIRING_SOON once per product", async () => {
    seedStore();
    // The LOW_STOCK half runs first for the same store — an empty
    // branch-stock set keeps it a no-op.
    stub.branchStock.findMany.mockResolvedValue([]);
    stub.notificationDispatch.findMany.mockResolvedValue([]);
    stub.product.findMany.mockResolvedValue([
      {
        id: "p-1",
        name: "Milk",
        expiryDate: new Date("2026-08-18T00:00:00.000Z"),
      },
    ]);
    stub.notificationDispatch.createMany.mockResolvedValue({ count: 1 });

    const result = await sweepAlerts(sender, new Date("2026-08-14T09:00:00.000Z"));

    expect(result.emailsSent).toBe(1);
    expect(sender.sendAlert).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({ subject: "Expiring soon — Fresh Mart" }),
    );
    expect(stub.notificationDispatch.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            kind: "EXPIRING_SOON",
            refType: "PRODUCT",
            refId: "p-1",
          }),
        ],
        skipDuplicates: true,
      }),
    );
  });

  it("is silent for stores with every toggle disabled", async () => {
    seedStore({ lowStockAlerts: false, paymentAlerts: false, expiringSoonAlerts: false });
    seedLowStockRows();

    const result = await sweepAlerts(sender);

    expect(result).toEqual({ storesScanned: 1, emailsSent: 0 });
    expect(sender.sendAlert).not.toHaveBeenCalled();
    expect(stub.branchStock.findMany).not.toHaveBeenCalled();
  });

  it("is silent for stores without an owner", async () => {
    stub.store.findMany.mockResolvedValue([
      { id: STORE_ID, name: "Fresh Mart", notificationSettings: null, owner: null },
    ]);

    const result = await sweepAlerts(sender);

    expect(result).toEqual({ storesScanned: 0, emailsSent: 0 });
    expect(sender.sendAlert).not.toHaveBeenCalled();
  });
});

describe("notifyPaymentReceived (unit)", () => {
  it("sends a PAYMENT_RECEIVED alert with the amount and writes a dispatch row", async () => {
    stub.store.findUnique.mockResolvedValue({
      name: "Fresh Mart",
      notificationSettings: null,
      owner: { account: { email: OWNER_EMAIL } },
    });
    stub.notificationDispatch.findUnique.mockResolvedValue(null);
    stub.order.findFirst.mockResolvedValue({
      total: { toFixed: () => "500.00" },
      customer: { name: "Ade Okafor" },
    });

    await notifyPaymentReceived(sender, STORE_ID, "ORDER", "order-1");

    expect(sender.sendAlert).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({
        subject: "Payment received — Fresh Mart",
        text: expect.stringContaining("500.00"),
      }),
    );
    expect(stub.notificationDispatch.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            kind: "PAYMENT_RECEIVED",
            refType: "ORDER",
            refId: "order-1",
          }),
        ],
      }),
    );
  });

  it("is a no-op when the paymentAlerts toggle is off", async () => {
    stub.store.findUnique.mockResolvedValue({
      name: "Fresh Mart",
      notificationSettings: { paymentAlerts: false },
      owner: { account: { email: OWNER_EMAIL } },
    });

    await notifyPaymentReceived(sender, STORE_ID, "ORDER", "order-1");

    expect(sender.sendAlert).not.toHaveBeenCalled();
    expect(stub.notificationDispatch.createMany).not.toHaveBeenCalled();
  });

  it("is a no-op when the dispatch already exists (send-once per financial row)", async () => {
    stub.store.findUnique.mockResolvedValue({
      name: "Fresh Mart",
      notificationSettings: null,
      owner: { account: { email: OWNER_EMAIL } },
    });
    stub.notificationDispatch.findUnique.mockResolvedValue({ id: "d-1" });

    await notifyPaymentReceived(sender, STORE_ID, "ORDER", "order-1");

    expect(sender.sendAlert).not.toHaveBeenCalled();
    expect(stub.order.findFirst).not.toHaveBeenCalled();
  });

  it("never throws when the store is missing", async () => {
    stub.store.findUnique.mockResolvedValue(null);

    await expect(
      notifyPaymentReceived(sender, STORE_ID, "ORDER", "order-1"),
    ).resolves.toBeUndefined();
    expect(sender.sendAlert).not.toHaveBeenCalled();
  });
});

describe("listDispatches (unit)", () => {
  it("pages newest-first with the id tie-break cursor", async () => {
    const rows: NotificationDispatchRow[] = [
      {
        id: "d-1",
        kind: "LOW_STOCK",
        refType: "BRANCH_STOCK",
        refId: "bs-1",
        sentQuantity: 3,
        snapshot: {},
        sentAt: new Date("2026-08-14T09:00:00.000Z"),
      },
    ];
    stub.notificationDispatch.findMany.mockResolvedValue(rows);

    const page = await listDispatches(STORE_ID, { limit: 20 });

    expect(page).toEqual({ dispatches: rows, nextCursor: null });
    expect(stub.notificationDispatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: STORE_ID },
        orderBy: [{ sentAt: "desc" }, { id: "desc" }],
        take: 20,
      }),
    );
  });
});

describe("email builders (unit)", () => {
  it("renders low-stock items with branch and threshold", () => {
    const email = buildLowStockAlertEmail("Fresh Mart", [
      { productName: "Tomatoes", branchName: "Main Branch", quantity: 3, threshold: 5 },
    ]);

    expect(email.subject).toBe("Low stock alert — Fresh Mart");
    expect(email.text).toContain("Tomatoes (Main Branch) — 3 left (threshold 5)");
  });

  it("renders the expiring date through the shared human-date formatter", () => {
    const email = buildExpiringSoonAlertEmail("Fresh Mart", [
      { productName: "Milk", expiryDate: new Date("2026-08-18T00:00:00.000Z") },
    ]);

    expect(email.text).toContain("Milk — expires");
  });

  it("renders payment alerts with the amount", () => {
    const email = buildPaymentAlertEmail("Fresh Mart", {
      label: "Checkout payment",
      amount: "500.00",
      detail: "Customer: Ade Okafor",
    });

    expect(email.subject).toBe("Payment received — Fresh Mart");
    expect(email.text).toContain("Checkout payment: 500.00");
    expect(email.text).toContain("Customer: Ade Okafor");
  });
});
