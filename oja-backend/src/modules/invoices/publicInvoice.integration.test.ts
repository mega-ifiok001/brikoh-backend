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
  return { account, store, token };
}

async function createBankAccount(storeId: string) {
  return prisma.bankAccount.create({
    data: {
      storeId,
      accountName: "Adebayo Idowu",
      bankName: "Access Bank",
      accountNumber: "0123456789",
      isDefault: true,
    },
  });
}

/** Creates a DRAFT invoice through the dashboard API and returns its id. */
async function createDraftInvoice(storeId: string, token: string) {
  const customer = await prisma.customer.create({
    data: { storeId, name: "Ade Okafor", phone: "+2348012345678" },
  });
  const product = await prisma.product.create({
    data: { storeId, name: `P ${crypto.randomUUID().slice(0, 8)}`, price: 550, quantity: 0 },
  });
  const res = await request(app)
    .post("/api/dashboard/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({
      customerId: customer.id,
      lineItems: [{ productId: product.id, quantity: 2, unitPriceAtIssue: "550.00" }],
    });
  expect(res.status).toBe(201);
  return { invoiceId: res.body.invoice.id as string, customer, product };
}

const TENANT_WIPE = `TRUNCATE TABLE
  "InvoicePayment", "InvoiceLineItem", "Invoice", "BankAccount",
  "StoreActivityLog", "Customer", "Product", "Branch", "Owner",
  "StaffMember", "Store", "Account"
RESTART IDENTITY CASCADE`;

beforeEach(async () => {
  await prisma.$executeRawUnsafe(TENANT_WIPE);
});

describe("GET /api/public/invoices/:invoiceId", () => {
  it("returns the issued invoice with items and the store's bank details, no auth", async () => {
    const { store, token } = await createTenantWithOwner();
    await createBankAccount(store.id);
    const { invoiceId } = await createDraftInvoice(store.id, token);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/issue`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // No Authorization header at all — this is the customer's view.
    const res = await request(app).get(`/api/public/invoices/${invoiceId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: invoiceId,
      number: "INV-0001",
      status: "ISSUED",
      storeName: store.name,
      customerName: "Ade Okafor",
      total: "1100.00",
      amountPaid: "0.00",
      balanceDue: "1100.00",
      isPayable: true,
      bankDetails: {
        bankName: "Access Bank",
        accountName: "Adebayo Idowu",
        accountNumber: "0123456789",
      },
    });
    expect(res.body.lineItems).toHaveLength(1);
    expect(res.body.lineItems[0]).toMatchObject({
      quantity: 2,
      unitPrice: "550.00",
      lineTotal: "1100.00",
    });
  });

  it("404s a DRAFT invoice — the link only goes live at issue", async () => {
    const { store, token } = await createTenantWithOwner();
    await createBankAccount(store.id);
    const { invoiceId } = await createDraftInvoice(store.id, token);

    const res = await request(app).get(`/api/public/invoices/${invoiceId}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("INVOICE_NOT_FOUND");
  });

  it("keeps working after a partial payment, showing the reduced balance", async () => {
    const { store, token } = await createTenantWithOwner();
    await createBankAccount(store.id);
    const { invoiceId } = await createDraftInvoice(store.id, token);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/issue`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "400.00" })
      .expect(200);

    const res = await request(app).get(`/api/public/invoices/${invoiceId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ISSUED",
      amountPaid: "400.00",
      balanceDue: "700.00",
      isPayable: true,
    });
    expect(res.body.bankDetails).not.toBeNull();
  });

  it("stops being payable and hides the account number once fully PAID", async () => {
    const { store, token } = await createTenantWithOwner();
    await createBankAccount(store.id);
    const { invoiceId } = await createDraftInvoice(store.id, token);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/issue`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "1100.00" })
      .expect(200);

    const res = await request(app).get(`/api/public/invoices/${invoiceId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "PAID",
      balanceDue: "0.00",
      isPayable: false,
      bankDetails: null,
    });
  });

  it("stops being payable and hides the account number once VOID", async () => {
    const { store, token } = await createTenantWithOwner();
    await createBankAccount(store.id);
    const { invoiceId } = await createDraftInvoice(store.id, token);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/issue`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/void`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const res = await request(app).get(`/api/public/invoices/${invoiceId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "VOID",
      isPayable: false,
      bankDetails: null,
    });
  });

  it("never leaks the payment ledger or the customer's phone/email", async () => {
    const { store, token } = await createTenantWithOwner();
    await createBankAccount(store.id);
    const { invoiceId } = await createDraftInvoice(store.id, token);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/issue`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "100.00", note: "Cash at counter" })
      .expect(200);

    const res = await request(app).get(`/api/public/invoices/${invoiceId}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("payments");
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("Cash at counter");
    expect(serialized).not.toContain("+2348012345678");
    expect(serialized).not.toContain(store.id);
  });

  it("404s an unknown invoice id", async () => {
    const res = await request(app).get(
      `/api/public/invoices/${"99999999-9999-4999-8999-999999999999"}`,
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("INVOICE_NOT_FOUND");
  });

  it("400s a malformed invoice id", async () => {
    const res = await request(app).get("/api/public/invoices/not-a-uuid");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns null bank details when the store never configured an account", async () => {
    const { store, token } = await createTenantWithOwner();
    const { invoiceId } = await createDraftInvoice(store.id, token);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/issue`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const res = await request(app).get(`/api/public/invoices/${invoiceId}`);

    expect(res.status).toBe(200);
    expect(res.body.isPayable).toBe(true);
    expect(res.body.bankDetails).toBeNull();
  });

  it("is read-only: writes to the public invoice path are not routed", async () => {
    const { store, token } = await createTenantWithOwner();
    const { invoiceId } = await createDraftInvoice(store.id, token);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/issue`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const post = await request(app).post(`/api/public/invoices/${invoiceId}`).send({});
    const patch = await request(app).patch(`/api/public/invoices/${invoiceId}`).send({});
    const del = await request(app).delete(`/api/public/invoices/${invoiceId}`);

    expect(post.status).toBe(404);
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);
  });
});

describe("dashboard invoice shareUrl", () => {
  it("is null while DRAFT and a public link once ISSUED", async () => {
    const { store, token } = await createTenantWithOwner();
    const { invoiceId } = await createDraftInvoice(store.id, token);

    const draft = await request(app)
      .get(`/api/dashboard/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(draft.status).toBe(200);
    expect(draft.body.invoice.shareUrl).toBeNull();
    expect(draft.body.invoice.linkEnabled).toBe(true);

    const issued = await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/issue`)
      .set("Authorization", `Bearer ${token}`);
    expect(issued.status).toBe(200);
    expect(issued.body.invoice.shareUrl).toContain(`/invoice/${invoiceId}`);
    expect(issued.body.invoice.linkEnabled).toBe(true);
  });
});

describe("invoice link enable/disable", () => {
  it("disabling the link 404s the public view without voiding the invoice", async () => {
    const { store, token } = await createTenantWithOwner();
    await createBankAccount(store.id);
    const { invoiceId } = await createDraftInvoice(store.id, token);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/issue`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const disabled = await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/disable-link`)
      .set("Authorization", `Bearer ${token}`);
    expect(disabled.status).toBe(200);
    expect(disabled.body.invoice.linkEnabled).toBe(false);
    expect(disabled.body.invoice.shareUrl).toBeNull();

    // The invoice still exists and is still ISSUED, not voided.
    const detail = await request(app)
      .get(`/api/dashboard/invoices/${invoiceId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.invoice.status).toBe("ISSUED");
    expect(detail.body.invoice.linkEnabled).toBe(false);

    const pub = await request(app).get(`/api/public/invoices/${invoiceId}`);
    expect(pub.status).toBe(404);
    expect(pub.body.error.code).toBe("INVOICE_NOT_FOUND");
  });

  it("re-enabling the link restores the public view", async () => {
    const { store, token } = await createTenantWithOwner();
    await createBankAccount(store.id);
    const { invoiceId } = await createDraftInvoice(store.id, token);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/issue`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/disable-link`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect((await request(app).get(`/api/public/invoices/${invoiceId}`)).status).toBe(404);

    const reenabled = await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/enable-link`)
      .set("Authorization", `Bearer ${token}`);
    expect(reenabled.status).toBe(200);
    expect(reenabled.body.invoice.linkEnabled).toBe(true);
    expect(reenabled.body.invoice.shareUrl).toContain(`/invoice/${invoiceId}`);

    const pub = await request(app).get(`/api/public/invoices/${invoiceId}`);
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe("ISSUED");
    expect(pub.body.isPayable).toBe(true);
  });

  it("cannot toggle the link on a DRAFT invoice", async () => {
    const { store, token } = await createTenantWithOwner();
    const { invoiceId } = await createDraftInvoice(store.id, token);

    const res = await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/disable-link`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVOICE_NOT_ISSUED");
  });

  it("404s on a link toggle for a foreign or unknown invoice", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post(`/api/dashboard/invoices/${"99999999-9999-4999-8999-999999999999"}/disable-link`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("INVOICE_NOT_FOUND");
  });

  it("requires the invoices.manage permission", async () => {
    const { store, token } = await createTenantWithOwner();
    const email = `staff-${crypto.randomUUID()}@example.com`;
    const staffAccount = await prisma.account.create({
      data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
    });
    const staff = await prisma.staffMember.create({
      data: { accountId: staffAccount.id, storeId: store.id, role: "STAFF", permissions: [] },
    });
    const staffToken = signAccessToken({
      sub: staffAccount.id,
      storeId: store.id,
      role: "STAFF",
      staffMemberId: staff.id,
    });
    const { invoiceId } = await createDraftInvoice(store.id, token);

    const res = await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/disable-link`)
      .set("Authorization", `Bearer ${staffToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });

  it("returns 404 for a disabled link regardless of invoice state", async () => {
    const { store, token } = await createTenantWithOwner();
    await createBankAccount(store.id);
    const { invoiceId } = await createDraftInvoice(store.id, token);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/issue`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "1100.00" })
      .expect(200);
    await request(app)
      .post(`/api/dashboard/invoices/${invoiceId}/disable-link`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const pub = await request(app).get(`/api/public/invoices/${invoiceId}`);
    expect(pub.status).toBe(404);
    expect(pub.body.error.code).toBe("INVOICE_NOT_FOUND");
  });
});
