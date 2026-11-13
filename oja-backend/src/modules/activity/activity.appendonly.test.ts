import { beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../lib/prisma.js";

/**
 * The StoreActivityLog table is append-only: inserts allowed, UPDATE/DELETE
 * rejected by a database trigger (the exact StockLedgerEntry/AdminAuditLog
 * discipline). These tests drive the real trigger on the test database —
 * the activity trail must be impossible to rewrite at the storage layer,
 * not just in the service.
 */

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

async function createStoreWithActivity() {
  const store = await prisma.store.create({
    data: {
      name: `Store ${crypto.randomUUID().slice(0, 8)}`,
      subdomain: `s-${crypto.randomUUID().slice(0, 8)}`,
      businessType: "OTHER",
      location: "Lagos, Nigeria",
      businessPhone: "+234 801 234 5678",
    },
  });
  const entry = await prisma.storeActivityLog.create({
    data: { storeId: store.id, action: "test.probe", detail: { probe: true } },
  });
  return { store, entry };
}

describe("StoreActivityLog append-only (DB trigger)", () => {
  beforeEach(async () => {
    await prisma.$executeRaw`
      ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
      ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" DISABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" DISABLE TRIGGER purchase_order_payment_append_only;
      DELETE FROM "RefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
      DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
      DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
      DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
      DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
      DELETE FROM "StoreActivityLog";
      DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
      ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
      ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
    `;
  });

  it("accepts inserts (happy path)", async () => {
    const { entry } = await createStoreWithActivity();
    expect(entry.action).toBe("test.probe");
  });

  it("rejects UPDATE of an activity row (sad path)", async () => {
    const { entry } = await createStoreWithActivity();
    await expect(
      prisma.storeActivityLog.update({
        where: { id: entry.id },
        data: { action: "test.tampered" },
      }),
    ).rejects.toThrow(/required but not found|append-only/i);
  });

  it("rejects DELETE of an activity row (sad path)", async () => {
    const { entry } = await createStoreWithActivity();
    await expect(prisma.storeActivityLog.delete({ where: { id: entry.id } })).rejects.toThrow(
      /required but not found|append-only/i,
    );
  });

  it("allows the tenant-root cascade (Store delete) to reach activity rows", async () => {
    const { store } = await createStoreWithActivity();
    // The DELETE of the store cascades to the log rows: the trigger's
    // pg_trigger_depth() guard exempts cascade-driven deletions.
    await expect(prisma.store.delete({ where: { id: store.id } })).resolves.toBeDefined();
  });
});
