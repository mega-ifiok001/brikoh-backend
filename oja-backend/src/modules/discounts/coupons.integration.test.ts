import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { encryptSecret } from "../../lib/secrets.js";
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

async function createProduct(storeId: string, price: number, quantity = 100) {
  const { defaultBranchId } = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { defaultBranchId: true },
  });
  const product = await prisma.product.create({
    data: {
      storeId,
      name: `Product ${crypto.randomUUID().slice(0, 8)}`,
      price,
      quantity,
      status: "PUBLISHED",
    },
  });
  await prisma.branchStock.create({
    data: { storeId, branchId: defaultBranchId!, productId: product.id, variantId: null, quantity },
  });
  return product;
}

async function createCustomer(storeId: string) {
  return prisma.customer.create({
    data: {
      storeId,
      name: `Customer ${crypto.randomUUID().slice(0, 8)}`,
      email: `cust-${crypto.randomUUID()}@example.com`,
    },
  });
}

async function createCoupon(
  storeId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; code: string }> {
  const code = `CPN${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const discount = await prisma.discount.create({
    data: {
      storeId,
      name: "Coupon",
      type: "PERCENTAGE",
      value: "10.00",
      code,
      ...overrides,
    },
  });
  return { id: discount.id, code };
}

function posBody(overrides: Record<string, unknown> = {}) {
  return { items: [{ productId: "product-1", quantity: 2 }], paymentMethod: "CASH", ...overrides };
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("coupons at the POS (integration)", () => {
  it("applies the coupon, records a redemption, and blocks a second use by the same customer", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProduct(store.id, 500);
    const customer = await createCustomer(store.id);
    const coupon = await createCoupon(store.id, { maxUses: 10 });

    const first = await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send(
        posBody({
          items: [{ productId: product.id, quantity: 2 }],
          customerId: customer.id,
          discountCode: coupon.code,
        }),
      );

    expect(first.status).toBe(201);
    expect(first.body.order.discountAmount).toBe("100.00");
    expect(first.body.order.discountId).toBe(coupon.id);

    const redemption = await prisma.couponRedemption.findFirst({
      where: { storeId: store.id, discountId: coupon.id },
    });
    expect(redemption).not.toBeNull();
    expect(redemption!.customerId).toBe(customer.id);

    const second = await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send(
        posBody({
          items: [{ productId: product.id, quantity: 2 }],
          customerId: customer.id,
          discountCode: coupon.code,
        }),
      );

    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe("COUPON_ALREADY_USED");
    expect(await prisma.couponRedemption.count({ where: { storeId: store.id } })).toBe(1);
  });

  it("rejects an exhausted coupon with COUPON_EXHAUSTED", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProduct(store.id, 500);
    const customer = await createCustomer(store.id);
    const coupon = await createCoupon(store.id, { maxUses: 1 });
    // A redemption row needs a real order (FK) — the deferred line-item
    // trigger requires order + items in one transaction.
    await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          storeId: store.id,
          customerId: customer.id,
          branchId: (
            await prisma.store.findUniqueOrThrow({
              where: { id: store.id },
              select: { defaultBranchId: true },
            })
          ).defaultBranchId!,
          orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
          status: "PAID",
          total: "500.00",
          paymentMethod: "CASH",
          amountPaid: "500.00",
          source: "POS",
        },
      });
      await tx.orderLineItem.create({
        data: {
          storeId: store.id,
          orderId: order.id,
          productId: product.id,
          quantity: 1,
          unitPriceAtPurchase: "500.00",
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
    });

    const res = await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send(
        posBody({
          items: [{ productId: product.id, quantity: 2 }],
          customerId: customer.id,
          discountCode: coupon.code,
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("COUPON_EXHAUSTED");
  });

  it("rejects a coupon below minSubtotal with COUPON_MIN_SUBTOTAL", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProduct(store.id, 200);
    const customer = await createCustomer(store.id);
    const coupon = await createCoupon(store.id, { minSubtotal: "500.00" });

    const res = await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send(
        posBody({
          items: [{ productId: product.id, quantity: 2 }],
          customerId: customer.id,
          discountCode: coupon.code,
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("COUPON_MIN_SUBTOTAL");
  });

  it("rejects a firstOrderOnly coupon for a customer with prior orders", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProduct(store.id, 500);
    const customer = await createCustomer(store.id);
    const coupon = await createCoupon(store.id, { firstOrderOnly: true });
    const defaultBranchId = (
      await prisma.store.findUniqueOrThrow({
        where: { id: store.id },
        select: { defaultBranchId: true },
      })
    ).defaultBranchId!;
    await prisma.$transaction(async (tx) => {
      const prior = await tx.order.create({
        data: {
          storeId: store.id,
          customerId: customer.id,
          branchId: defaultBranchId,
          orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
          status: "PAID",
          total: "100.00",
          paymentMethod: "CASH",
          amountPaid: "100.00",
          source: "POS",
        },
      });
      await tx.orderLineItem.create({
        data: {
          storeId: store.id,
          orderId: prior.id,
          productId: product.id,
          quantity: 1,
          unitPriceAtPurchase: "100.00",
        },
      });
    });

    const res = await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send(
        posBody({
          items: [{ productId: product.id, quantity: 2 }],
          customerId: customer.id,
          discountCode: coupon.code,
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("COUPON_FIRST_ORDER_ONLY");
  });

  it("does not record redemptions for plain discounts (no coupon rules)", async () => {
    const { store, token } = await createTenantWithOwner();
    const product = await createProduct(store.id, 500);
    const customer = await createCustomer(store.id);
    const coupon = await createCoupon(store.id, { code: "PLAIN10" });

    const res = await request(app)
      .post("/api/dashboard/orders")
      .set("Authorization", `Bearer ${token}`)
      .send(
        posBody({
          items: [{ productId: product.id, quantity: 2 }],
          customerId: customer.id,
          discountCode: "PLAIN10",
        }),
      );

    expect(res.status).toBe(201);
    expect(await prisma.couponRedemption.count({ where: { storeId: store.id } })).toBe(0);
    void coupon;
  });
});

describe("coupons at storefront checkout (integration)", () => {
  it("applies the coupon and records a redemption in the order transaction", async () => {
    const { store } = await createTenantWithOwner();
    await prisma.paymentCredential.create({
      data: {
        storeId: store.id,
        provider: "paystack",
        publicKey: "pk_test_1234abcd",
        secretKeyEncrypted: encryptSecret("sk_test_1234abcd5678efgh"),
      },
    });
    const product = await createProduct(store.id, 9.99);
    const coupon = await createCoupon(store.id, { maxUses: 10 });
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            message: "Authorization URL created",
            data: {
              authorization_url: "https://checkout.paystack.test/session",
              access_code: "a",
              reference: "r",
            },
          }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app)
      .post(`/api/public/checkout/${store.subdomain}`)
      .send({
        customer: { name: "Ade Buyer", email: "buyer@example.com", phone: "08012345678" },
        items: [{ productId: product.id, quantity: 2 }],
        discountCode: coupon.code,
      });

    expect(res.status).toBe(200);
    expect(res.body.order.discountAmount).toBe("2.00");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id } });
    const redemption = await prisma.couponRedemption.findFirst({
      where: { storeId: store.id, discountId: coupon.id },
    });
    expect(redemption).not.toBeNull();
    expect(redemption!.orderId).toBe(order.id);
  });
});
