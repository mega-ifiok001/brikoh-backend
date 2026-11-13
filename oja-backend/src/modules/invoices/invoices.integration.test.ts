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

async function createCustomerRow(storeId: string, name = "Ade Okafor") {
  return prisma.customer.create({ data: { storeId, name } });
}

async function createProductRow(storeId: string, price = 550) {
  return prisma.product.create({
    data: { storeId, name: `P ${crypto.randomUUID().slice(0, 8)}`, price, quantity: 0 },
  });
}

beforeEach(async () => {
  await prisma.$executeRaw`
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" DISABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" DISABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_ledger_append_only;
    DELETE FROM "RefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
    DELETE FROM "CreditRepayment"; DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoicePayment";
    DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
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

describe("invoices CRUD (integration)", () => {
  it("creates a DRAFT with computed total and logs activity", async () => {
    const { store, token } = await createTenantWithOwner();
    const customer = await createCustomerRow(store.id);
    const product = await createProductRow(store.id, 550);

    const res = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        dueDate: "2026-09-01T00:00:00.000Z",
        lineItems: [
          { productId: product.id, quantity: 2, unitPriceAtIssue: "550.00" },
          { productId: product.id, quantity: 1, unitPriceAtIssue: "150.00" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.invoice).toMatchObject({
      status: "DRAFT",
      number: null,
      total: "1250.00",
      amountPaid: "0.00",
      balanceDue: "1250.00",
      customer: { id: customer.id, name: "Ade Okafor" },
    });
    expect(res.body.lineItems).toHaveLength(2);
    expect(res.body.payments).toEqual([]);
    expect(
      await prisma.storeActivityLog.count({
        where: { storeId: store.id, action: "invoice.created" },
      }),
    ).toBe(1);
  });

  it("rejects unknown customers and cross-store products", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProductRow(store.id);

    const badCustomer = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: "00000000-0000-0000-0000-000000000000",
        lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "10.00" }],
      });
    expect(badCustomer.status).toBe(404);
    expect(badCustomer.body.error.code).toBe("CUSTOMER_NOT_FOUND");

    const { store: foreign } = await createTenantWithOwner();
    const foreignProduct = await createProductRow(foreign.id);
    const customer = await createCustomerRow(store.id);
    const badProduct = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        lineItems: [{ productId: foreignProduct.id, quantity: 1, unitPriceAtIssue: "10.00" }],
      });
    expect(badProduct.status).toBe(404);
    expect(badProduct.body.error.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("lists invoices with status filter, search, and pagination", async () => {
    const { store, token } = await createTenantWithOwner();
    const customer = await createCustomerRow(store.id);
    const product = await createProductRow(store.id);
    const created = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "10.00" }],
      });

    const res = await request(app)
      .get("/api/dashboard/invoices?status=DRAFT&q=ade&limit=10")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: created.body.invoice.id,
      status: "DRAFT",
      number: null,
      balanceDue: "10.00",
      itemCount: 1,
      customer: { id: customer.id, name: "Ade Okafor" },
    });
    expect(res.body.nextCursor).toBeNull();
  });

  it("updates a DRAFT's line items and total, then rejects updates after issue", async () => {
    const { store, token } = await createTenantWithOwner();
    const customer = await createCustomerRow(store.id);
    const product = await createProductRow(store.id);
    const created = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        lineItems: [{ productId: product.id, quantity: 2, unitPriceAtIssue: "550.00" }],
      });

    const updated = await request(app)
      .put(`/api/dashboard/invoices/${created.body.invoice.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        dueDate: null,
        lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "100.00" }],
      });
    expect(updated.status).toBe(200);
    expect(updated.body.invoice).toMatchObject({ total: "100.00", balanceDue: "100.00" });
    expect(updated.body.lineItems).toHaveLength(1);

    const issued = await request(app)
      .post(`/api/dashboard/invoices/${created.body.invoice.id}/issue`)
      .set("Authorization", `Bearer ${token}`);
    expect(issued.status).toBe(200);

    const rejected = await request(app)
      .put(`/api/dashboard/invoices/${created.body.invoice.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "1.00" }] });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("INVOICE_NOT_DRAFT");
  });

  it("deletes a DRAFT but rejects deleting an issued invoice", async () => {
    const { store, token } = await createTenantWithOwner();
    const customer = await createCustomerRow(store.id);
    const product = await createProductRow(store.id);
    const created = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "10.00" }],
      });

    const deleted = await request(app)
      .delete(`/api/dashboard/invoices/${created.body.invoice.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    expect(await prisma.invoice.findUnique({ where: { id: created.body.invoice.id } })).toBeNull();

    const again = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "10.00" }],
      });
    await request(app)
      .post(`/api/dashboard/invoices/${again.body.invoice.id}/issue`)
      .set("Authorization", `Bearer ${token}`);
    const rejected = await request(app)
      .delete(`/api/dashboard/invoices/${again.body.invoice.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("INVOICE_NOT_DRAFT");
  });

  it("404s unknown and cross-tenant invoices", async () => {
    const { token } = await createTenantWithOwner();
    const { store: foreign, token: foreignToken } = await createTenantWithOwner();
    const customer = await createCustomerRow(foreign.id);
    const product = await createProductRow(foreign.id);
    const foreignInvoice = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${foreignToken}`)
      .send({
        customerId: customer.id,
        lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "10.00" }],
      });

    const missing = await request(app)
      .get("/api/dashboard/invoices/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(404);

    const crossTenant = await request(app)
      .get(`/api/dashboard/invoices/${foreignInvoice.body.invoice.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.error.code).toBe("INVOICE_NOT_FOUND");
  });

  it("requires the invoices.manage permission", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id, ["customers.manage"]);
    const customer = await createCustomerRow(store.id);
    const product = await createProductRow(store.id);

    const res = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "10.00" }],
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });
});

describe("invoice lifecycle and payments (integration)", () => {
  async function issuedInvoice(token: string, storeId: string, total = 1000) {
    const customer = await createCustomerRow(storeId);
    const product = await createProductRow(storeId);
    const created = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: String(total) }],
      });
    const issued = await request(app)
      .post(`/api/dashboard/invoices/${created.body.invoice.id}/issue`)
      .set("Authorization", `Bearer ${token}`);
    expect(issued.status).toBe(200);
    return { invoice: issued.body.invoice, token };
  }

  it("issues sequentially numbered invoices per store (INV-0001, INV-0002)", async () => {
    const { store, token } = await createTenantWithOwner();
    const customer = await createCustomerRow(store.id);
    const product = await createProductRow(store.id);

    for (const expected of ["INV-0001", "INV-0002"]) {
      const created = await request(app)
        .post("/api/dashboard/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerId: customer.id,
          lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "10.00" }],
        });
      const issued = await request(app)
        .post(`/api/dashboard/invoices/${created.body.invoice.id}/issue`)
        .set("Authorization", `Bearer ${token}`);
      expect(issued.status).toBe(200);
      expect(issued.body.invoice.number).toBe(expected);
      expect(issued.body.invoice.issuedAt).not.toBeNull();
    }
  });

  it("records partial payments, advancing amountPaid until PAID", async () => {
    const { store, token } = await createTenantWithOwner();
    const { invoice } = await issuedInvoice(token, store.id, 1000);
    const { staff, token: staffToken } = await createStaffMember(store.id, ["invoices.manage"]);
    await prisma.account.update({
      where: { id: staff.accountId },
      data: { firstName: "Chidi", lastName: "Manager" },
    });

    const first = await request(app)
      .post(`/api/dashboard/invoices/${invoice.id}/payments`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ amount: "600.00", note: "First installment" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      invoiceId: invoice.id,
      status: "ISSUED",
      allocated: "600.00",
      balanceDue: "400.00",
      totalOutstanding: "1000.00",
    });

    const second = await request(app)
      .post(`/api/dashboard/invoices/${invoice.id}/payments`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ amount: "400.00" });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: "PAID", balanceDue: "0.00" });

    const detail = await request(app)
      .get(`/api/dashboard/invoices/${invoice.id}`)
      .set("Authorization", `Bearer ${staffToken}`);
    expect(detail.body.invoice.status).toBe("PAID");
    expect(detail.body.invoice.amountPaid).toBe("1000.00");
    expect(detail.body.payments).toEqual([
      {
        id: expect.any(String),
        amount: "600.00",
        note: "First installment",
        recordedByName: "Chidi Manager",
        createdAt: expect.any(String),
      },
      {
        id: expect.any(String),
        amount: "400.00",
        note: null,
        recordedByName: "Chidi Manager",
        createdAt: expect.any(String),
      },
    ]);
    const ledger = await prisma.invoicePayment.findMany({ where: { invoiceId: invoice.id } });
    expect(ledger.map((p) => p.amount.toFixed(2))).toEqual(["600.00", "400.00"]);
    expect(ledger.every((p) => p.recordedByStaffId === staff.id)).toBe(true);
  });

  it("rejects over-payment and payments on drafts or paid invoices", async () => {
    const { store, token } = await createTenantWithOwner();
    const customer = await createCustomerRow(store.id);
    const product = await createProductRow(store.id);
    const created = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "500.00" }],
      });

    const onDraft = await request(app)
      .post(`/api/dashboard/invoices/${created.body.invoice.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "10.00" });
    expect(onDraft.status).toBe(409);
    expect(onDraft.body.error.code).toBe("INVOICE_NOT_ISSUED");

    await request(app)
      .post(`/api/dashboard/invoices/${created.body.invoice.id}/issue`)
      .set("Authorization", `Bearer ${token}`);

    const overpay = await request(app)
      .post(`/api/dashboard/invoices/${created.body.invoice.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "500.01" });
    expect(overpay.status).toBe(409);
    expect(overpay.body.error.code).toBe("PAYMENT_EXCEEDS_BALANCE");

    await request(app)
      .post(`/api/dashboard/invoices/${created.body.invoice.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "500.00" });
    const again = await request(app)
      .post(`/api/dashboard/invoices/${created.body.invoice.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "10.00" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("INVOICE_NOT_ISSUED");
  });

  it("voids an unpaid issued invoice but not one with payments", async () => {
    const { store, token } = await createTenantWithOwner();
    const customer = await createCustomerRow(store.id);
    const product = await createProductRow(store.id);

    const created = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "500.00" }],
      });
    await request(app)
      .post(`/api/dashboard/invoices/${created.body.invoice.id}/issue`)
      .set("Authorization", `Bearer ${token}`);
    const voided = await request(app)
      .post(`/api/dashboard/invoices/${created.body.invoice.id}/void`)
      .set("Authorization", `Bearer ${token}`);
    expect(voided.status).toBe(200);
    expect(voided.body.invoice.status).toBe("VOID");

    const { invoice } = await issuedInvoice(token, store.id, 500);
    await request(app)
      .post(`/api/dashboard/invoices/${invoice.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "250.00" });
    const blocked = await request(app)
      .post(`/api/dashboard/invoices/${invoice.id}/void`)
      .set("Authorization", `Bearer ${token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("INVOICE_HAS_PAYMENTS");

    const draftVoid = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "10.00" }],
      });
    const draftBlocked = await request(app)
      .post(`/api/dashboard/invoices/${draftVoid.body.invoice.id}/void`)
      .set("Authorization", `Bearer ${token}`);
    expect(draftBlocked.status).toBe(409);
    expect(draftBlocked.body.error.code).toBe("INVOICE_NOT_ISSUED");
  });

  it("blocks ledger mutations at the database layer (append-only trigger)", async () => {
    const { store, token } = await createTenantWithOwner();
    const { invoice } = await issuedInvoice(token, store.id, 500);
    await request(app)
      .post(`/api/dashboard/invoices/${invoice.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "250.00" });
    const ledger = await prisma.invoicePayment.findFirst({ where: { invoiceId: invoice.id } });

    await expect(
      prisma.invoicePayment.update({ where: { id: ledger!.id }, data: { amount: 1 } }),
    ).rejects.toThrow();
    await expect(prisma.invoicePayment.delete({ where: { id: ledger!.id } })).rejects.toThrow();
    expect(await prisma.invoicePayment.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  it("attributes lifecycle activity to the acting staff member", async () => {
    const { store } = await createTenantWithOwner();
    const { staff, token } = await createStaffMember(store.id, ["invoices.manage"]);
    const customer = await createCustomerRow(store.id);
    const product = await createProductRow(store.id);

    const created = await request(app)
      .post("/api/dashboard/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerId: customer.id,
        lineItems: [{ productId: product.id, quantity: 1, unitPriceAtIssue: "500.00" }],
      });
    await request(app)
      .post(`/api/dashboard/invoices/${created.body.invoice.id}/issue`)
      .set("Authorization", `Bearer ${token}`);
    await request(app)
      .post(`/api/dashboard/invoices/${created.body.invoice.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "500.00" });

    const entries = await prisma.storeActivityLog.findMany({
      where: { storeId: store.id },
      select: { action: true, staffMemberId: true },
      orderBy: { createdAt: "asc" },
    });
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "invoice.created", staffMemberId: staff.id }),
        expect.objectContaining({ action: "invoice.issued", staffMemberId: staff.id }),
        expect.objectContaining({ action: "invoice.payment.recorded", staffMemberId: staff.id }),
      ]),
    );
  });
});
