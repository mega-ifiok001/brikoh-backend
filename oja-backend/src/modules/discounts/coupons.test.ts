import { describe, expect, it, vi } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import { assertCouponEligible, createCouponRedemption } from "./apply.js";

type Mock = ReturnType<typeof vi.fn>;

interface CouponClientStub {
  discount: { findUnique: Mock };
  couponRedemption: { count: Mock; create: Mock };
  order: { count: Mock };
}

const STORE_ID = "c0000000-0000-4000-8000-000000000001";
const DISCOUNT_ID = "c0000000-0000-4000-8000-000000000002";
const CUSTOMER_ID = "c0000000-0000-4000-8000-000000000003";
const ORDER_ID = "c0000000-0000-4000-8000-000000000004";
const D = (v: string | number) => new Prisma.Decimal(v);
const NOW = new Date("2026-08-19T10:00:00.000Z");

function createClientStub(): CouponClientStub {
  return {
    discount: { findUnique: vi.fn() },
    couponRedemption: { count: vi.fn(), create: vi.fn() },
    order: { count: vi.fn() },
  };
}

/** Plain discount row with no coupon rules (the pre-coupon shape). */
function plainDiscountRow() {
  return {
    id: DISCOUNT_ID,
    storeId: STORE_ID,
    maxUses: null,
    perCustomerUses: null,
    minSubtotal: null,
    firstOrderOnly: null,
  };
}

/** Coupon row carrying every rule. */
function couponRow() {
  return {
    ...plainDiscountRow(),
    maxUses: 100,
    perCustomerUses: 2,
    minSubtotal: "5000.00",
    firstOrderOnly: true,
  };
}

describe("assertCouponEligible", () => {
  it("returns false for a plain discount with no coupon limits (no redemption needed)", async () => {
    const client = createClientStub();
    client.discount.findUnique.mockResolvedValue(plainDiscountRow());

    const isCoupon = await assertCouponEligible(
      client as never,
      STORE_ID,
      DISCOUNT_ID,
      CUSTOMER_ID,
      D("10000.00"),
      NOW,
    );

    expect(isCoupon).toBe(false);
    expect(client.couponRedemption.count).not.toHaveBeenCalled();
  });

  it("returns true for an eligible coupon", async () => {
    const client = createClientStub();
    client.discount.findUnique.mockResolvedValue(couponRow());
    client.couponRedemption.count
      .mockResolvedValueOnce(3) // global count (below maxUses 100)
      .mockResolvedValueOnce(1); // per-customer count (below perCustomerUses 2)
    client.order.count.mockResolvedValue(0);

    const isCoupon = await assertCouponEligible(
      client as never,
      STORE_ID,
      DISCOUNT_ID,
      CUSTOMER_ID,
      D("10000.00"),
      NOW,
    );

    expect(isCoupon).toBe(true);
    expect(client.couponRedemption.count).toHaveBeenCalledWith({
      where: { discountId: DISCOUNT_ID, storeId: STORE_ID },
    });
  });

  it("throws COUPON_EXHAUSTED when global redemptions reached maxUses", async () => {
    const client = createClientStub();
    client.discount.findUnique.mockResolvedValue(couponRow());
    client.couponRedemption.count.mockResolvedValue(100);
    client.order.count.mockResolvedValue(0);

    await expect(
      assertCouponEligible(client as never, STORE_ID, DISCOUNT_ID, CUSTOMER_ID, D("10000.00"), NOW),
    ).rejects.toMatchObject({ code: "COUPON_EXHAUSTED" });
  });

  it("throws COUPON_ALREADY_USED when the customer hit perCustomerUses", async () => {
    const client = createClientStub();
    client.discount.findUnique.mockResolvedValue(couponRow());
    client.couponRedemption.count
      .mockResolvedValueOnce(3) // global count
      .mockResolvedValueOnce(2); // per-customer count
    client.order.count.mockResolvedValue(0);

    await expect(
      assertCouponEligible(client as never, STORE_ID, DISCOUNT_ID, CUSTOMER_ID, D("10000.00"), NOW),
    ).rejects.toMatchObject({ code: "COUPON_ALREADY_USED" });
  });

  it("throws COUPON_MIN_SUBTOTAL when the line total is below minSubtotal", async () => {
    const client = createClientStub();
    client.discount.findUnique.mockResolvedValue(couponRow());
    client.couponRedemption.count.mockResolvedValue(0);
    client.order.count.mockResolvedValue(0);

    await expect(
      assertCouponEligible(client as never, STORE_ID, DISCOUNT_ID, CUSTOMER_ID, D("4999.99"), NOW),
    ).rejects.toMatchObject({ code: "COUPON_MIN_SUBTOTAL" });
  });

  it("allows a line total exactly at minSubtotal", async () => {
    const client = createClientStub();
    client.discount.findUnique.mockResolvedValue(couponRow());
    client.couponRedemption.count.mockResolvedValue(0);
    client.order.count.mockResolvedValue(0);

    const isCoupon = await assertCouponEligible(
      client as never,
      STORE_ID,
      DISCOUNT_ID,
      CUSTOMER_ID,
      D("5000.00"),
      NOW,
    );

    expect(isCoupon).toBe(true);
  });

  it("throws COUPON_FIRST_ORDER_ONLY when the customer already has orders", async () => {
    const client = createClientStub();
    client.discount.findUnique.mockResolvedValue(couponRow());
    client.couponRedemption.count.mockResolvedValue(0);
    client.order.count.mockResolvedValue(1);

    await expect(
      assertCouponEligible(client as never, STORE_ID, DISCOUNT_ID, CUSTOMER_ID, D("10000.00"), NOW),
    ).rejects.toMatchObject({ code: "COUPON_FIRST_ORDER_ONLY" });
  });

  it("returns false when every coupon rule is unset, regardless of customer history", async () => {
    const client = createClientStub();
    client.discount.findUnique.mockResolvedValue({
      ...plainDiscountRow(),
    });
    client.couponRedemption.count.mockResolvedValue(0);
    client.order.count.mockResolvedValue(5);

    const isCoupon = await assertCouponEligible(
      client as never,
      STORE_ID,
      DISCOUNT_ID,
      CUSTOMER_ID,
      D("10.00"),
      NOW,
    );

    expect(isCoupon).toBe(false);
    expect(client.order.count).not.toHaveBeenCalled();
  });
});

describe("createCouponRedemption", () => {
  it("inserts the redemption row", async () => {
    const client = createClientStub();
    client.couponRedemption.create.mockResolvedValue({ id: "redemption-1" });

    const redemption = await createCouponRedemption(client as never, {
      storeId: STORE_ID,
      discountId: DISCOUNT_ID,
      orderId: ORDER_ID,
      customerId: CUSTOMER_ID,
    });

    expect(redemption).toEqual({ id: "redemption-1" });
    expect(client.couponRedemption.create).toHaveBeenCalledWith({
      data: {
        storeId: STORE_ID,
        discountId: DISCOUNT_ID,
        orderId: ORDER_ID,
        customerId: CUSTOMER_ID,
      },
    });
  });
});
