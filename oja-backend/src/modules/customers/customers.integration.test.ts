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

async function createCreditOrder(
  storeId: string,
  branchId: string,
  customerId: string,
  total: number,
  amountPaid: number,
) {
  const product = await prisma.product.create({
    data: { storeId, name: `P ${crypto.randomUUID().slice(0, 8)}`, price: total, quantity: 0 },
  });
  return prisma.order.create({
    data: {
      storeId,
      customerId,
      branchId,
      orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
      source: "POS",
      paymentMethod: "CREDIT",
      total,
      amountPaid,
      lineItems: {
        create: {
          storeId,
          productId: product.id,
          quantity: 1,
          unitPriceAtPurchase: total,
        },
      },
    },
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
    DELETE FROM "CreditRepayment"; DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
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

describe("customers CRUD (integration)", () => {
  it("creates a customer with a zero credit balance and logs activity", async () => {
    const { store, token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade Okafor", phone: "+2348012345678", email: "ADE@EXAMPLE.COM" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "Ade Okafor",
      phone: "+2348012345678",
      email: "ade@example.com",
      openCredit: "0.00",
      hasOutstandingCredit: false,
    });
    expect(await prisma.customer.count({ where: { storeId: store.id } })).toBe(1);
    const activity = await prisma.storeActivityLog.findFirst({
      where: { storeId: store.id, action: "customer.created" },
    });
    expect(activity).not.toBeNull();
    expect(activity?.staffMemberId).toBeNull();
  });

  it("rejects a duplicate email with 409 CUSTOMER_EXISTS", async () => {
    const { token } = await createTenantWithOwner();
    await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "First", email: "same@example.com" });

    const res = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Second", email: "SAME@example.com" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CUSTOMER_EXISTS");
  });

  it("lists customers with search and pagination", async () => {
    const { token } = await createTenantWithOwner();
    for (const name of ["Zainab Musa", "Ade Okafor"]) {
      await request(app)
        .post("/api/dashboard/customers")
        .set("Authorization", `Bearer ${token}`)
        .send({ name });
    }

    const res = await request(app)
      .get("/api/dashboard/customers?q=ade&limit=10")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ name: "Ade Okafor", openCredit: "0.00" });
  });

  it("updates a customer and clears phone with explicit null", async () => {
    const { token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade", phone: "+2348012345678" });

    const res = await request(app)
      .put(`/api/dashboard/customers/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade O.", phone: null });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.body.id, name: "Ade O.", phone: null });
  });

  it("404s updates for unknown or cross-tenant customers", async () => {
    const { token } = await createTenantWithOwner();
    const { store: foreign } = await createTenantWithOwner();
    const foreignCustomer = await prisma.customer.create({
      data: { storeId: foreign.id, name: "Foreign" },
    });

    const missing = await request(app)
      .put("/api/dashboard/customers/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "X" });
    expect(missing.status).toBe(404);

    const crossTenant = await request(app)
      .put(`/api/dashboard/customers/${foreignCustomer.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "X" });
    expect(crossTenant.status).toBe(404);
  });

  it("deletes a customer with no records", async () => {
    const { store, token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade" });

    const res = await request(app)
      .delete(`/api/dashboard/customers/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await prisma.customer.findUnique({ where: { id: created.body.id } })).toBeNull();
    expect(
      await prisma.storeActivityLog.count({
        where: { storeId: store.id, action: "customer.deleted" },
      }),
    ).toBe(1);
  });

  it("rejects deleting a customer with order history (409 CUSTOMER_HAS_RECORDS)", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade" });
    await createCreditOrder(store.id, mainBranch.id, created.body.id, 500, 500);

    const res = await request(app)
      .delete(`/api/dashboard/customers/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CUSTOMER_HAS_RECORDS");
  });

  it("requires the customers.manage permission", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id, ["orders.manage"]);
    void store;

    const res = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });
});

describe("customer credit (integration)", () => {
  it("reports open credit and paid-off credit across orders in detail", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade" });
    await createCreditOrder(store.id, mainBranch.id, created.body.id, 5000, 1500);
    await createCreditOrder(store.id, mainBranch.id, created.body.id, 500, 500);

    const res = await request(app)
      .get(`/api/dashboard/customers/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.customer).toMatchObject({
      id: created.body.id,
      openCredit: "3500.00",
      hasOutstandingCredit: true,
    });
    expect(res.body.recentOrders).toHaveLength(2);
    expect(res.body.recentOrders[0]).toMatchObject({ paymentMethod: "CREDIT" });
    expect(res.body.repayments).toEqual([]);
  });

  it("records a repayment, advancing amountPaid and writing an immutable ledger row", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade" });
    const order = await createCreditOrder(store.id, mainBranch.id, created.body.id, 5000, 1500);

    const res = await request(app)
      .post(`/api/dashboard/customers/${created.body.id}/credits/repayments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "2000.00", note: "First installment" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      allocated: [{ orderId: order.id, amount: "2000.00" }],
      remaining: "0.00",
      totalOutstanding: "3500.00",
    });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated?.amountPaid?.toFixed(2)).toBe("3500.00");

    const ledger = await prisma.creditRepayment.findMany({ where: { orderId: order.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      storeId: store.id,
      orderId: order.id,
      amount: expect.anything(),
      note: "First installment",
      recordedByStaffId: null,
    });
    expect(ledger[0]!.amount.toFixed(2)).toBe("2000.00");

    const activity = await prisma.storeActivityLog.findFirst({
      where: { storeId: store.id, action: "credit.repayment.recorded" },
    });
    expect(activity).not.toBeNull();
  });

  it("distributes a repayment across orders oldest-first", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade" });
    const first = await createCreditOrder(store.id, mainBranch.id, created.body.id, 1000, 400);
    const second = await createCreditOrder(store.id, mainBranch.id, created.body.id, 2000, 0);

    const res = await request(app)
      .post(`/api/dashboard/customers/${created.body.id}/credits/repayments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "2500.00" });

    expect(res.status).toBe(200);
    expect(res.body.allocated).toEqual([
      { orderId: first.id, amount: "600.00" },
      { orderId: second.id, amount: "1900.00" },
    ]);
    expect(res.body.totalOutstanding).toBe("2600.00");
  });

  it("rejects repayments beyond the balance and with nothing outstanding", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade" });
    await createCreditOrder(store.id, mainBranch.id, created.body.id, 500, 500);

    const noBalance = await request(app)
      .post(`/api/dashboard/customers/${created.body.id}/credits/repayments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "10.00" });
    expect(noBalance.status).toBe(409);
    expect(noBalance.body.error.code).toBe("NO_OUTSTANDING_CREDIT");

    await createCreditOrder(store.id, mainBranch.id, created.body.id, 1000, 0);
    const overpay = await request(app)
      .post(`/api/dashboard/customers/${created.body.id}/credits/repayments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "1000.01" });
    expect(overpay.status).toBe(409);
    expect(overpay.body.error.code).toBe("REPAYMENT_EXCEEDS_BALANCE");
  });

  it("surfaces repayments in order detail with the recorder's name", async () => {
    const { store, mainBranch } = await createTenantWithOwner();
    const { staff, token } = await createStaffMember(store.id, [
      "customers.manage",
      "orders.manage",
    ]);
    await prisma.account.update({
      where: { id: staff.accountId },
      data: { firstName: "Chidi", lastName: "Manager" },
    });
    const created = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade" });
    const order = await createCreditOrder(store.id, mainBranch.id, created.body.id, 800, 300);

    await request(app)
      .post(`/api/dashboard/customers/${created.body.id}/credits/repayments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "500.00" });

    const detail = await request(app)
      .get(`/api/dashboard/orders/${order.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.repayments).toHaveLength(1);
    expect(detail.body.repayments[0]).toMatchObject({
      amount: "500.00",
      recordedByName: "Chidi Manager",
    });

    const ledgerRow = await prisma.creditRepayment.findFirst({ where: { orderId: order.id } });
    expect(ledgerRow?.recordedByStaffId).toBe(staff.id);
  });

  it("blocks ledger mutations at the database layer (append-only trigger)", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ade" });
    const order = await createCreditOrder(store.id, mainBranch.id, created.body.id, 500, 0);
    await request(app)
      .post(`/api/dashboard/customers/${created.body.id}/credits/repayments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "250.00" });
    const ledger = await prisma.creditRepayment.findFirst({ where: { orderId: order.id } });

    await expect(
      prisma.creditRepayment.update({
        where: { id: ledger!.id },
        data: { amount: 1 },
      }),
    ).rejects.toThrow();
    await expect(prisma.creditRepayment.delete({ where: { id: ledger!.id } })).rejects.toThrow();
    expect(await prisma.creditRepayment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("filters the customer list by outstanding credit", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const debtor = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Debtor" });
    const payer = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Payer" });
    await createCreditOrder(store.id, mainBranch.id, debtor.body.id, 1000, 0);
    await createCreditOrder(store.id, mainBranch.id, payer.body.id, 1000, 1000);

    const res = await request(app)
      .get("/api/dashboard/customers?hasOutstandingCredit=true")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(["Debtor"]);
  });
});

describe("customer provenance enrichments (integration)", () => {
  async function seedOrder(
    storeId: string,
    branchId: string,
    customerId: string,
    status: string,
    total: number,
  ) {
    return prisma.order.create({
      data: {
        storeId,
        customerId,
        branchId,
        orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
        status: status as never,
        paymentMethod: "CASH",
        total,
        amountPaid: total,
        lineItems: {
          create: {
            storeId,
            productId: (
              await prisma.product.create({
                data: {
                  storeId,
                  name: `P ${crypto.randomUUID().slice(0, 8)}`,
                  price: total,
                  quantity: 0,
                },
              })
            ).id,
            quantity: 1,
            unitPriceAtPurchase: total,
          },
        },
      },
    });
  }

  it("reports source, segment, ordersCount and totalSpent on list and detail", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const customer = await prisma.customer.create({
      data: { storeId: store.id, name: "Ade", email: "ade@example.com", phone: "08012345678" },
    });
    await seedOrder(store.id, mainBranch.id, customer.id, "PENDING", 1000);
    await seedOrder(store.id, mainBranch.id, customer.id, "PAID", 1500);
    await seedOrder(store.id, mainBranch.id, customer.id, "SHIPPED", 1000);

    const list = await request(app)
      .get("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    const row = list.body.items.find((item: { id: string }) => item.id === customer.id);
    expect(row).toMatchObject({
      source: "MANUAL",
      segment: "REGULAR",
      ordersCount: 3,
      totalSpent: "2500.00",
    });

    const detail = await request(app)
      .get(`/api/dashboard/customers/${customer.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.customer).toMatchObject({
      source: "MANUAL",
      segment: "REGULAR",
      ordersCount: 3,
      totalSpent: "2500.00",
    });
  });

  it("segments NEW with zero orders and VIP at 1,000,000 lifetime spend", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const newcomer = await prisma.customer.create({
      data: { storeId: store.id, name: "New", email: "new@example.com" },
    });
    const vip = await prisma.customer.create({
      data: { storeId: store.id, name: "Vip", email: "vip@example.com" },
    });
    await seedOrder(store.id, mainBranch.id, vip.id, "PAID", 600000);
    await seedOrder(store.id, mainBranch.id, vip.id, "PAID", 400000);

    const list = await request(app)
      .get("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    const byId = new Map(
      list.body.items.map((item: { id: string; segment: string; totalSpent: string }) => [
        item.id,
        item,
      ]),
    );
    expect(byId.get(newcomer.id)).toMatchObject({ segment: "NEW", totalSpent: "0.00" });
    expect(byId.get(vip.id)).toMatchObject({ segment: "VIP", totalSpent: "1000000.00" });
  });

  it("tags dashboard-created customers MANUAL", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Manual", phone: "08012345678" });

    expect(res.status).toBe(201);
    expect(res.body.source).toBe("MANUAL");
    const row = await prisma.customer.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.source).toBe("MANUAL");
  });

  it("exports the address book as CSV", async () => {
    const { store, mainBranch, token } = await createTenantWithOwner();
    const customer = await prisma.customer.create({
      data: {
        storeId: store.id,
        name: "Ade, Okafor",
        email: "ade@example.com",
        phone: "08012345678",
      },
    });
    await seedOrder(store.id, mainBranch.id, customer.id, "PAID", 1500);

    const res = await request(app)
      .get("/api/dashboard/customers/export.csv")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const text = String(res.text);
    expect(text.split("\r\n")[0]).toBe(
      "name,phone,email,group,source,segment,ordersCount,totalSpent,openCredit,createdAt",
    );
    expect(text).toContain('"Ade, Okafor"');
    expect(text).toContain("MANUAL,REGULAR,1,1500.00");
  });

  it("imports a CSV batch atomically with duplicates skipped by email", async () => {
    const { store, token } = await createTenantWithOwner();
    const existing = await prisma.customer.create({
      data: { storeId: store.id, name: "Old", email: "old@example.com" },
    });

    const csv = [
      "name,phone,email",
      "Ade,+2348012345678,ade@example.com",
      "Old,08012345678,old@example.com",
      "Ade again,08011111111,ade@example.com",
    ].join("\n");

    const res = await request(app)
      .post("/api/dashboard/customers/import")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "text/csv")
      .send(csv);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: 1, skipped: 2 });
    const imported = await prisma.customer.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(imported).toBeTruthy();
    const row = await prisma.customer.findFirstOrThrow({
      where: { storeId: store.id, email: "ade@example.com" },
    });
    expect(row.source).toBe("IMPORTED");
  });

  it("imports valid rows but reports per-row validation errors", async () => {
    const { token } = await createTenantWithOwner();

    const csv = [
      "name,phone,email",
      "Good,08012345678,good@example.com",
      "Bad,123,bad@example.com",
    ].join("\n");

    const res = await request(app)
      .post("/api/dashboard/customers/import")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "text/csv")
      .send(csv);

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toContain("row 3");
  });

  it("rejects file-level failures with 400 and imports nothing", async () => {
    const { store, token } = await createTenantWithOwner();

    const badHeader = await request(app)
      .post("/api/dashboard/customers/import")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "text/csv")
      .send("name,phone,bogus\nAde,08012345678");
    expect(badHeader.status).toBe(400);
    expect(badHeader.body.error.code).toBe("VALIDATION_ERROR");

    const tooBig = ["name,phone", ...Array.from({ length: 501 }, () => "X,08012345678")].join("\n");
    const big = await request(app)
      .post("/api/dashboard/customers/import")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "text/csv")
      .send(tooBig);
    expect(big.status).toBe(400);
    expect(big.body.error.code).toBe("VALIDATION_ERROR");

    expect(await prisma.customer.count({ where: { storeId: store.id } })).toBe(0);
  });
});
