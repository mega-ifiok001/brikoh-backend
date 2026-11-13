import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";
import type { $Enums } from "../../../generated/prisma/client.js";

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
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  const token = signAccessToken({ sub: account.id, storeId: store.id, role: "OWNER" });
  return { store, token };
}

async function createStaffMember(
  storeId: string,
  permissions: string[],
  role: $Enums.StaffRole = "STAFF",
) {
  const email = `staff-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const staff = await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role, permissions },
  });
  const token = signAccessToken({ sub: account.id, storeId, role });
  return { staff, token };
}

beforeEach(async () => {
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
    DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

const VALID = {
  fileName: "mug photo.png",
  contentType: "image/png",
  declaredSizeBytes: 1_000_000,
};

describe("POST /api/dashboard/uploads/presign-product-image (integration)", () => {
  it("returns Cloudinary signing params scoped to the authenticated store", async () => {
    const { store, token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/uploads/presign-product-image")
      .set("Authorization", `Bearer ${token}`)
      .send(VALID);

    expect(res.status).toBe(200);
    expect(res.body.key).toMatch(new RegExp(`^stores/${store.id}/[0-9a-f-]{36}-mugphoto\\.png$`));
    expect(res.body.expiresInSeconds).toBe(300);
    expect(res.body.cloudName).toBe(process.env.CLOUDINARY_CLOUD_NAME);
    expect(res.body.apiKey).toBe(process.env.CLOUDINARY_API_KEY);
    expect(res.body.folder).toBe(`${process.env.CLOUDINARY_FOLDER_PREFIX}/${store.id}`);
    expect(res.body.publicId).toMatch(/^[0-9a-f-]{36}-mugphoto\.png$/);
    expect(res.body.timestamp).toEqual(expect.any(Number));
    expect(res.body.signature).toMatch(/^[a-f0-9]{40}$/);
    expect(res.body.publicUrl).toBe(
      `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/${res.body.folder}/${res.body.publicId}`,
    );
  });

  it("scopes keys to the authenticated tenant — two stores never share a prefix", async () => {
    const storeA = await createTenantWithOwner();
    const storeB = await createTenantWithOwner();

    const [a, b] = await Promise.all([
      request(app)
        .post("/api/dashboard/uploads/presign-product-image")
        .set("Authorization", `Bearer ${storeA.token}`)
        .send(VALID),
      request(app)
        .post("/api/dashboard/uploads/presign-product-image")
        .set("Authorization", `Bearer ${storeB.token}`)
        .send(VALID),
    ]);

    expect(a.body.key.startsWith(`stores/${storeA.store.id}/`)).toBe(true);
    expect(b.body.key.startsWith(`stores/${storeB.store.id}/`)).toBe(true);
    expect(a.body.key).not.toContain(storeB.store.id);
    expect(b.body.key).not.toContain(storeA.store.id);
  });

  it("rejects content types outside the allowlist", async () => {
    const { token } = await createTenantWithOwner();
    const res = await request(app)
      .post("/api/dashboard/uploads/presign-product-image")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...VALID, contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNSUPPORTED_CONTENT_TYPE");
  });

  it("rejects declared sizes above 10 MB", async () => {
    const { token } = await createTenantWithOwner();
    const res = await request(app)
      .post("/api/dashboard/uploads/presign-product-image")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...VALID, declaredSizeBytes: 10_485_761 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FILE_TOO_LARGE");
  });

  it("rejects malformed bodies", async () => {
    const { token } = await createTenantWithOwner();
    const res = await request(app)
      .post("/api/dashboard/uploads/presign-product-image")
      .set("Authorization", `Bearer ${token}`)
      .send({ fileName: "", contentType: "image/png", declaredSizeBytes: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).post("/api/dashboard/uploads/presign-product-image").send(VALID);
    expect(res.status).toBe(401);
  });

  it("rejects staff without products.manage", async () => {
    const { store } = await createTenantWithOwner();
    const { token } = await createStaffMember(store.id, []);
    const res = await request(app)
      .post("/api/dashboard/uploads/presign-product-image")
      .set("Authorization", `Bearer ${token}`)
      .send(VALID);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });
});
