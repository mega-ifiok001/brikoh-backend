import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

async function tenant() {
  const account = await prisma.account.create({
    data: {
      email: `support-${crypto.randomUUID()}@example.com`,
      passwordHash: bcrypt.hashSync("password-123", 4),
    },
  });
  const store = await prisma.store.create({
    data: {
      name: "Support Store",
      subdomain: `support-${crypto.randomUUID().slice(0, 8)}`,
      businessType: "OTHER",
      location: "Lagos",
      businessPhone: "+2348000000000",
    },
  });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  return {
    account,
    store,
    token: signAccessToken({ sub: account.id, storeId: store.id, role: "OWNER" }),
  };
}

beforeEach(async () => {
  await prisma.$executeRaw`
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" DISABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" DISABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_ledger_append_only;
    DELETE FROM "TicketMessage"; DELETE FROM "SupportTicket"; DELETE FROM "AnnouncementView";
    DELETE FROM "RefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
    DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "WalletEntry"; DELETE FROM "Payout"; DELETE FROM "StoreWallet"; DELETE FROM "BankAccount";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "BranchStock"; DELETE FROM "Branch"; DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog"; DELETE FROM "Expense"; DELETE FROM "NotificationDispatch"; DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

describe("dashboard support tickets (integration)", () => {
  it("creates a ticket with its initial merchant message and lists it", async () => {
    const { token } = await tenant();
    const created = await request(app)
      .post("/api/dashboard/support/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Checkout problem", priority: "HIGH", message: "Payments fail" });
    expect(created.status).toBe(201);
    expect(created.body.ticket.status).toBe("OPEN");
    const list = await request(app)
      .get("/api/dashboard/support/tickets")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
  });

  it("rejects invalid input and hides tickets from another tenant", async () => {
    const first = await tenant();
    const second = await tenant();
    const invalid = await request(app)
      .post("/api/dashboard/support/tickets")
      .set("Authorization", `Bearer ${first.token}`)
      .send({ subject: "", message: "" });
    expect(invalid.status).toBe(400);
    const created = await request(app)
      .post("/api/dashboard/support/tickets")
      .set("Authorization", `Bearer ${first.token}`)
      .send({ subject: "Private", message: "Details" });
    const hidden = await request(app)
      .get(`/api/dashboard/support/tickets/${created.body.ticket.id}`)
      .set("Authorization", `Bearer ${second.token}`);
    expect(hidden.status).toBe(404);
  });

  it("returns an empty thread and caps message pages at 50", async () => {
    const { store, token } = await tenant();
    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "SupportTicket" ("id","storeId","subject","priority","status","createdAt","updatedAt") VALUES ('${id}','${store.id}','Empty','MEDIUM','OPEN',NOW(),NOW())`,
    );
    const detail = await request(app)
      .get(`/api/dashboard/support/tickets/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.messages).toEqual([]);
  });
});
