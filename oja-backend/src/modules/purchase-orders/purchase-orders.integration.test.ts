import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

async function createTenantWithOwner() {
  const email = `owner-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const store = await prisma.store.create({
    data: {
      name: `Store ${crypto.randomUUID().slice(0, 8)}`,
      subdomain: `s-${crypto.randomUUID().slice(0, 8)}`,
      businessType: "OTHER",
      location: "Lagos, Nigeria",
      businessPhone: "+234 801 234 5678",
    },
  });
  const mainBranch = await prisma.branch.create({
    data: { storeId: store.id, name: "Main Branch", address: "Lagos, Nigeria" },
  });
  await prisma.store.update({ where: { id: store.id }, data: { defaultBranchId: mainBranch.id } });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  const token = signAccessToken({ sub: account.id, storeId: store.id, role: "OWNER" });
  return { account, store, mainBranch, token };
}

async function createStaffMember(storeId: string, permissions: string[]) {
  const email = `staff-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const staff = await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role: "STAFF", permissions },
  });
  const token = signAccessToken({
    sub: account.id,
    storeId,
    role: "STAFF",
    staffMemberId: staff.id,
  });
  return { account, staff, token };
}

beforeEach(async () => {
  await prisma.$executeRaw`
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" DISABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" DISABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_ledger_append_only;
    DELETE FROM "RefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
    DELETE FROM "CreditRepayment"; DELETE FROM "Order"; DELETE FROM "InvoicePayment";
    DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

async function seedSupplierAndProduct(storeId: string) {
  const supplier = await prisma.supplier.create({
    data: { storeId, name: `S ${crypto.randomUUID().slice(0, 8)}` },
  });
  const product = await prisma.product.create({
    data: { storeId, name: `P ${crypto.randomUUID().slice(0, 8)}`, price: 550, quantity: 0 },
  });
  return { supplier, product };
}

describe("purchase orders lifecycle (integration)", () => {
  it("creates a DRAFT, issues it with a sequential number, and logs activity", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const { supplier, product } = await seedSupplierAndProduct(store.id);

    const created = await request(app)
      .post("/api/dashboard/purchase-orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId: supplier.id,
        branchId: mainBranch.id,
        notes: "Weekly order",
        lineItems: [{ productId: product.id, quantity: 10, unitCostAtOrder: "500.00" }],
      });

    expect(created.status).toBe(201);
    expect(created.body.purchaseOrder).toMatchObject({
      status: "DRAFT",
      total: "5000.00",
      balanceDue: "5000.00",
      number: null,
      supplier: { id: supplier.id },
      branch: { id: mainBranch.id },
    });
    expect(created.body.lineItems[0]).toMatchObject({
      quantity: 10,
      quantityReceived: 0,
      remainingToReceive: 10,
      unitCostAtOrder: "500.00",
      lineTotal: "5000.00",
    });

    const issued = await request(app)
      .post(`/api/dashboard/purchase-orders/${created.body.purchaseOrder.id}/issue`)
      .set("Authorization", `Bearer ${token}`);

    expect(issued.status).toBe(200);
    expect(issued.body.purchaseOrder).toMatchObject({ status: "ORDERED", number: "PO-0001" });

    const activity = await prisma.storeActivityLog.findMany({
      where: {
        storeId: store.id,
        action: { in: ["purchaseOrder.created", "purchaseOrder.issued"] },
      },
    });
    expect(activity).toHaveLength(2);
  });

  it("receives goods into stock with RESTOCK ledger entries and reaches RECEIVED", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const { supplier, product } = await seedSupplierAndProduct(store.id);
    const created = await prisma.purchaseOrder.create({
      data: {
        storeId: store.id,
        supplierId: supplier.id,
        branchId: mainBranch.id,
        status: "ORDERED",
        number: "PO-0001",
        total: 5000,
        orderedAt: new Date(),
        lineItems: {
          create: [
            {
              storeId: store.id,
              productId: product.id,
              quantity: 10,
              unitCostAtOrder: 500,
            },
          ],
        },
      },
      include: { lineItems: true },
    });

    const partial = await request(app)
      .post(`/api/dashboard/purchase-orders/${created.id}/receive`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        note: "First drop",
        lineItems: [{ lineItemId: created.lineItems[0]!.id, quantityReceived: 4 }],
      });

    expect(partial.status).toBe(200);
    expect(partial.body.purchaseOrder.status).toBe("PARTIALLY_RECEIVED");
    expect(partial.body.lineItems[0]).toMatchObject({
      quantityReceived: 4,
      remainingToReceive: 6,
    });

    const full = await request(app)
      .post(`/api/dashboard/purchase-orders/${created.id}/receive`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        lineItems: [{ lineItemId: created.lineItems[0]!.id, quantityReceived: 6 }],
      });

    expect(full.status).toBe(200);
    expect(full.body.purchaseOrder).toMatchObject({
      status: "RECEIVED",
      receivedAt: expect.any(String),
    });

    const stockRow = await prisma.branchStock.findFirstOrThrow({
      where: { branchId: mainBranch.id, productId: product.id },
    });
    expect(stockRow.quantity).toBe(10);
    const productRow = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(productRow.quantity).toBe(10);

    const ledger = await prisma.stockLedgerEntry.findMany({
      where: { productId: product.id, reason: "RESTOCK", referenceId: created.id },
      orderBy: { createdAt: "asc" },
    });
    expect(ledger).toHaveLength(2);
    expect(ledger.map((entry) => entry.quantityChange)).toEqual([4, 6]);
    expect(ledger[0]!.branchId).toBe(mainBranch.id);

    const receipts = await prisma.purchaseOrderReceipt.count({
      where: { purchaseOrderId: created.id },
    });
    expect(receipts).toBe(2);

    const activity = await prisma.storeActivityLog.findMany({
      where: { storeId: store.id, action: "purchaseOrder.received" },
    });
    expect(activity).toHaveLength(2);
  });

  it("rejects over-receipt, receiving on a DRAFT, and editing an ORDERED order", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const { supplier, product } = await seedSupplierAndProduct(store.id);

    const created = await request(app)
      .post("/api/dashboard/purchase-orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId: supplier.id,
        branchId: mainBranch.id,
        lineItems: [{ productId: product.id, quantity: 10, unitCostAtOrder: "500.00" }],
      });
    const poId = created.body.purchaseOrder.id;
    const lineId = created.body.lineItems[0].id;

    const receivedOnDraft = await request(app)
      .post(`/api/dashboard/purchase-orders/${poId}/receive`)
      .set("Authorization", `Bearer ${token}`)
      .send({ lineItems: [{ lineItemId: lineId, quantityReceived: 1 }] });
    expect(receivedOnDraft.status).toBe(409);
    expect(receivedOnDraft.body.error.code).toBe("ORDER_NOT_RECEIVABLE");

    await request(app)
      .post(`/api/dashboard/purchase-orders/${poId}/issue`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const overReceipt = await request(app)
      .post(`/api/dashboard/purchase-orders/${poId}/receive`)
      .set("Authorization", `Bearer ${token}`)
      .send({ lineItems: [{ lineItemId: lineId, quantityReceived: 11 }] });
    expect(overReceipt.status).toBe(400);

    const edit = await request(app)
      .put(`/api/dashboard/purchase-orders/${poId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        supplierId: supplier.id,
        branchId: mainBranch.id,
        lineItems: [{ productId: product.id, quantity: 5, unitCostAtOrder: "500.00" }],
      });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("ORDER_NOT_EDITABLE");
  });

  it("records payments against the balance and blocks overpayment", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const { supplier, product } = await seedSupplierAndProduct(store.id);
    const created = await prisma.purchaseOrder.create({
      data: {
        storeId: store.id,
        supplierId: supplier.id,
        branchId: mainBranch.id,
        status: "ORDERED",
        number: "PO-0001",
        total: 7500,
        orderedAt: new Date(),
        lineItems: {
          create: [
            {
              storeId: store.id,
              productId: product.id,
              quantity: 15,
              unitCostAtOrder: 500,
            },
          ],
        },
      },
    });

    const paid = await request(app)
      .post(`/api/dashboard/purchase-orders/${created.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "3000.00", note: "Advance" });

    expect(paid.status).toBe(200);
    expect(paid.body).toEqual({
      amount: "3000.00",
      allocated: "3000.00",
      balanceDue: "4500.00",
    });

    const over = await request(app)
      .post(`/api/dashboard/purchase-orders/${created.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "5000.00" });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe("PAYMENT_EXCEEDS_BALANCE");

    const detail = await request(app)
      .get(`/api/dashboard/purchase-orders/${created.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.body.purchaseOrder).toMatchObject({
      amountPaid: "3000.00",
      balanceDue: "4500.00",
    });
    expect(detail.body.payments).toHaveLength(1);
    expect(detail.body.payments[0]).toMatchObject({ amount: "3000.00" });
  });

  it("cancels an order only before receipts and reflects debt on the supplier", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const { supplier, product } = await seedSupplierAndProduct(store.id);
    const cancelled = await prisma.purchaseOrder.create({
      data: {
        storeId: store.id,
        supplierId: supplier.id,
        branchId: mainBranch.id,
        status: "DRAFT",
        total: 1000,
      },
    });
    const received = await prisma.purchaseOrder.create({
      data: {
        storeId: store.id,
        supplierId: supplier.id,
        branchId: mainBranch.id,
        status: "ORDERED",
        number: "PO-0001",
        total: 3000,
        orderedAt: new Date(),
        lineItems: {
          create: [
            {
              storeId: store.id,
              productId: product.id,
              quantity: 3,
              unitCostAtOrder: 1000,
            },
          ],
        },
      },
    });

    const cancelOk = await request(app)
      .post(`/api/dashboard/purchase-orders/${cancelled.id}/cancel`)
      .set("Authorization", `Bearer ${token}`);
    expect(cancelOk.status).toBe(200);
    expect(cancelOk.body.purchaseOrder.status).toBe("CANCELLED");

    await request(app)
      .post(`/api/dashboard/purchase-orders/${received.id}/receive`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        lineItems: [
          {
            lineItemId: (
              await prisma.purchaseOrderLineItem.findFirstOrThrow({
                where: { purchaseOrderId: received.id },
              })
            ).id,
            quantityReceived: 1,
          },
        ],
      })
      .expect(200);

    const cancelRefused = await request(app)
      .post(`/api/dashboard/purchase-orders/${received.id}/cancel`)
      .set("Authorization", `Bearer ${token}`);
    expect(cancelRefused.status).toBe(409);
    expect(cancelRefused.body.error.code).toBe("ORDER_NOT_CANCELLABLE");

    const supplierDetail = await request(app)
      .get(`/api/dashboard/suppliers/${supplier.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(supplierDetail.body.balanceDue).toBe("3000.00");
    expect(supplierDetail.body.purchaseOrders).toHaveLength(2);
  });

  it("rejects staff without purchases.manage", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id, []);

    const res = await request(app)
      .get("/api/dashboard/purchase-orders")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });
});
