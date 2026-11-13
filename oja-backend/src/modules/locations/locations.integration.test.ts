import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

beforeEach(async () => {
  // DELETE instead of TRUNCATE (see auth.integration.test.ts). The
  // append-only stock trigger blocks DELETE, so it is disabled during
  // the wipe like every other integration suite does.
  await prisma.$executeRaw`
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" DISABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" DISABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_ledger_append_only;
    DELETE FROM "RefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
    DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "WalletEntry"; DELETE FROM "Payout"; DELETE FROM "StoreWallet"; DELETE FROM "BankAccount";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "Subscription"; DELETE FROM "Location"; DELETE FROM "Store";
    DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

async function createTenantWithOwner(name: string) {
  const email = `owner-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const store = await prisma.store.create({
    data: {
      name,
      subdomain: `s-${crypto.randomUUID().slice(0, 8)}`,
      businessType: "OTHER",
      location: "Lagos, Nigeria",
      businessPhone: "+234 801 234 5678",
    },
  });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  return { account, store, email };
}

async function ownerToken(accountId: string): Promise<string> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const res = await request(app)
    .post("/api/public/auth/login")
    .send({ email: account.email, password: "password-123" });
  return res.body.accessToken as string;
}

describe("locations — tenant isolation (integration)", () => {
  it("never lists another store's locations; creations land only on the caller's store", async () => {
    const { store: storeA, account: accountA } = await createTenantWithOwner("A Shop");
    const { store: storeB, account: accountB } = await createTenantWithOwner("B Shop");
    await prisma.location.create({ data: { storeId: storeA.id, name: "Victoria Island" } });

    const tokenA = await ownerToken(accountA.id);
    const tokenB = await ownerToken(accountB.id);

    const listA = await request(app)
      .get("/api/dashboard/locations")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(listA.status).toBe(200);
    expect(listA.body.map((l: { name: string }) => l.name)).toEqual(["Victoria Island"]);

    const listB = await request(app)
      .get("/api/dashboard/locations")
      .set("Authorization", `Bearer ${tokenB}`);
    expect(listB.status).toBe(200);
    expect(listB.body).toEqual([]);

    const created = await request(app)
      .post("/api/dashboard/locations")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ name: "Yaba" });
    expect(created.status).toBe(201);

    const rows = await prisma.location.findMany();
    expect(rows).toHaveLength(2);
    const rowsForB = rows.filter((l) => l.storeId === storeB.id);
    expect(rowsForB).toHaveLength(1);
    expect(rowsForB[0]?.name).toBe("Yaba");
  });
});
