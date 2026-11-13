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
  const branch = await prisma.branch.create({
    data: { storeId: store.id, name: "Main Branch", address: "Lagos, Nigeria" },
  });
  await prisma.store.update({ where: { id: store.id }, data: { defaultBranchId: branch.id } });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  const token = signAccessToken({ sub: account.id, storeId: store.id, role: "OWNER" });
  return { account, store, mainBranch: branch, token };
}

async function createStaffMember(
  storeId: string,
  options: { role: "ADMIN" | "MANAGER" | "STAFF"; permissions: string[] },
) {
  const email = `staff-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync("password-123", 4) },
  });
  const staff = await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role: options.role, permissions: options.permissions },
  });
  const token = signAccessToken({
    sub: account.id,
    storeId,
    role: options.role,
    staffMemberId: staff.id,
  });
  return { staff, account, token };
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
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "CouponRedemption"; DELETE FROM "Campaign";
    DELETE FROM "Expense";
    DELETE FROM "NotificationDispatch";
    DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

describe("dashboard campaigns (integration)", () => {
  it("creates a campaign, returns it with the linked coupon code, and logs the activity", async () => {
    const { store, token } = await createTenantWithOwner();
    const coupon = await prisma.discount.create({
      data: {
        storeId: store.id,
        name: "August 20%",
        type: "PERCENTAGE",
        value: "20.00",
        code: "AUGUST20",
      },
    });

    const res = await request(app)
      .post("/api/dashboard/campaigns")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "August Clearance",
        bannerTitle: "August Clearance",
        bannerSubtitle: "Up to 20% off everything",
        ctaLabel: "Shop now",
        discountId: coupon.id,
      });

    expect(res.status).toBe(201);
    expect(res.body.campaign).toMatchObject({
      name: "August Clearance",
      bannerTitle: "August Clearance",
      bannerSubtitle: "Up to 20% off everything",
      ctaLabel: "Shop now",
      discountId: coupon.id,
      discountCode: "AUGUST20",
      isActive: true,
    });

    const activity = await prisma.storeActivityLog.findFirst({
      where: { storeId: store.id, action: "campaign.created" },
    });
    expect(activity).not.toBeNull();
  });

  it("lists campaigns newest-first and updates only the provided fields", async () => {
    const { store, token } = await createTenantWithOwner();
    await prisma.campaign.create({
      data: { storeId: store.id, name: "Old", isActive: false },
    });
    const first = await prisma.campaign.create({
      data: { storeId: store.id, name: "Evergreen", isActive: true },
    });

    const listRes = await request(app)
      .get("/api/dashboard/campaigns")
      .set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(2);
    expect(listRes.body.items[0].id).toBe(first.id);

    const updateRes = await request(app)
      .put(`/api/dashboard/campaigns/${first.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ ctaLabel: "Buy now" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.campaign).toMatchObject({ ctaLabel: "Buy now", name: "Evergreen" });

    const activity = await prisma.storeActivityLog.findFirst({
      where: { storeId: store.id, action: "campaign.updated" },
    });
    expect(activity).not.toBeNull();
  });

  it("deletes a campaign without touching the linked coupon", async () => {
    const { store, token } = await createTenantWithOwner();
    const coupon = await prisma.discount.create({
      data: {
        storeId: store.id,
        name: "Clearance",
        type: "PERCENTAGE",
        value: "10.00",
        code: "CLEAR10",
      },
    });
    const campaign = await prisma.campaign.create({
      data: { storeId: store.id, name: "Clearance", discountId: coupon.id },
    });

    const res = await request(app)
      .delete(`/api/dashboard/campaigns/${campaign.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await prisma.campaign.findUnique({ where: { id: campaign.id } })).toBeNull();
    expect(await prisma.discount.findUnique({ where: { id: coupon.id } })).not.toBeNull();
  });

  it("rejects a cross-tenant discountId with DISCOUNT_NOT_FOUND", async () => {
    const { token } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    const foreignCoupon = await prisma.discount.create({
      data: {
        storeId: other.store.id,
        name: "Other coupon",
        type: "PERCENTAGE",
        value: "10.00",
        code: "OTHER10",
      },
    });

    const res = await request(app)
      .post("/api/dashboard/campaigns")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Sneaky", discountId: foreignCoupon.id });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("DISCOUNT_NOT_FOUND");
  });

  it("requires marketing.manage for all writes", async () => {
    const { store } = await createTenantWithOwner();
    const staff = await createStaffMember(store.id, { role: "STAFF", permissions: [] });

    const res = await request(app)
      .post("/api/dashboard/campaigns")
      .set("Authorization", `Bearer ${staff.token}`)
      .send({ name: "Nope" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });

  it("allows staff with marketing.manage to manage campaigns", async () => {
    const { store } = await createTenantWithOwner();
    const staff = await createStaffMember(store.id, {
      role: "MANAGER",
      permissions: ["marketing.manage"],
    });

    const res = await request(app)
      .get("/api/dashboard/campaigns")
      .set("Authorization", `Bearer ${staff.token}`);

    expect(res.status).toBe(200);
  });
});

describe("storefront campaign banner (integration)", () => {
  it("exposes the banner only while the campaign window is live", async () => {
    const { store } = await createTenantWithOwner();
    const coupon = await prisma.discount.create({
      data: {
        storeId: store.id,
        name: "August 20%",
        type: "PERCENTAGE",
        value: "20.00",
        code: "AUGUST20",
      },
    });
    await prisma.campaign.create({
      data: {
        storeId: store.id,
        name: "August Clearance",
        startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        bannerTitle: "August Clearance",
        bannerSubtitle: "Up to 20% off everything",
        ctaLabel: "Shop now",
        discountId: coupon.id,
      },
    });

    const before = await request(app).get(`/api/public/storefront/${store.subdomain}`);
    expect(before.status).toBe(200);
    expect(before.body.campaign).toBeNull();

    await prisma.campaign.update({
      where: { id: (await prisma.campaign.findFirstOrThrow({ where: { storeId: store.id } })).id },
      data: { startsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const during = await request(app).get(`/api/public/storefront/${store.subdomain}`);
    expect(during.status).toBe(200);
    expect(during.body.campaign).toEqual({
      bannerTitle: "August Clearance",
      bannerSubtitle: "Up to 20% off everything",
      ctaLabel: "Shop now",
    });
    expect(during.body.campaign.discountCode).toBeUndefined();
  });

  it("hides the banner for inactive campaigns", async () => {
    const { store } = await createTenantWithOwner();
    await prisma.campaign.create({
      data: { storeId: store.id, name: "Paused", isActive: false, bannerTitle: "Paused" },
    });

    const res = await request(app).get(`/api/public/storefront/${store.subdomain}`);
    expect(res.status).toBe(200);
    expect(res.body.campaign).toBeNull();
  });
});

describe("GET /api/dashboard/campaigns/stats (integration)", () => {
  it("reports totals, live counts, and per-campaign attributed revenue", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await prisma.product.create({
      data: { storeId: store.id, name: `P ${crypto.randomUUID().slice(0, 8)}`, price: "5000.00" },
    });
    const coupon = await prisma.discount.create({
      data: {
        storeId: store.id,
        name: "Independence 10%",
        type: "PERCENTAGE",
        value: "10.00",
        code: "INDEP10",
        maxUses: 100,
      },
    });
    const campaign = await prisma.campaign.create({
      data: {
        storeId: store.id,
        name: "Independence Week",
        startsAt: new Date("2026-01-01T00:00:00.000Z"),
        endsAt: new Date("2026-12-31T23:59:59.999Z"),
        discountId: coupon.id,
      },
    });
    await prisma.campaign.create({
      data: { storeId: store.id, name: "Evergreen Banner", isActive: true },
    });
    await prisma.campaign.create({
      data: { storeId: store.id, name: "Paused", isActive: false },
    });

    const customer = await prisma.customer.create({
      data: { storeId: store.id, name: "Buyer", email: `buyer-${crypto.randomUUID()}@example.com` },
    });
    const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
      where: { id: store.id },
      select: { defaultBranchId: true },
    });
    await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          storeId: store.id,
          customerId: customer.id,
          branchId: defaultBranchId!,
          orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
          status: "PAID",
          total: "5000.00",
          paymentMethod: "CASH",
          amountPaid: "5000.00",
          source: "POS",
        },
      });
      await tx.orderLineItem.create({
        data: {
          storeId: store.id,
          orderId: order.id,
          productId: product.id,
          quantity: 1,
          unitPriceAtPurchase: "5000.00",
        },
      });
      await tx.couponRedemption.create({
        data: {
          storeId: store.id,
          discountId: coupon.id,
          orderId: order.id,
          customerId: customer.id,
        },
      });
      const pending = await tx.order.create({
        data: {
          storeId: store.id,
          customerId: customer.id,
          branchId: defaultBranchId!,
          orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
          status: "PENDING",
          total: "3000.00",
          paymentProvider: "paystack",
          paymentReference: `ref-${crypto.randomUUID()}`,
        },
      });
      await tx.orderLineItem.create({
        data: {
          storeId: store.id,
          orderId: pending.id,
          productId: product.id,
          quantity: 1,
          unitPriceAtPurchase: "3000.00",
        },
      });
      await tx.couponRedemption.create({
        data: {
          storeId: store.id,
          discountId: coupon.id,
          orderId: pending.id,
          customerId: customer.id,
        },
      });
    });

    const res = await request(app)
      .get("/api/dashboard/campaigns/stats")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalCampaigns).toBe(3);
    expect(res.body.activeCampaigns).toBe(2); // Independence Week + Evergreen
    expect(res.body.activeCoupons).toBe(1);
    expect(res.body.totalRedemptions).toBe(2);
    const row = res.body.campaigns.find((c: { id: string }) => c.id === campaign.id) as {
      discountCode: string;
      redemptions: number;
      attributedOrders: number;
      attributedRevenue: string;
    };
    expect(row).toMatchObject({
      discountCode: "INDEP10",
      redemptions: 2,
      attributedOrders: 1, // only the PAID order counts
      attributedRevenue: "5000.00",
    });
    const banner = res.body.campaigns.find(
      (c: { name: string }) => c.name === "Evergreen Banner",
    ) as {
      discountCode: null;
      redemptions: number;
      attributedOrders: number;
      attributedRevenue: string;
    };
    expect(banner).toMatchObject({
      discountCode: null,
      redemptions: 0,
      attributedOrders: 0,
      attributedRevenue: "0.00",
    });
  });
});
