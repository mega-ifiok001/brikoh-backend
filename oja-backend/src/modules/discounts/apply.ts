import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";

/**
 * ============================================================
 * DISCOUNT APPLICATION (shared by POS record-sale + public checkout)
 * ============================================================
 * Sale-time resolution and amount computation for managed discounts.
 *
 * - An explicit discount (id or code) is resolved and validated:
 *   unknown/cross-tenant -> 404 DISCOUNT_NOT_FOUND; not active or
 *   outside its validity window -> 400 DISCOUNT_UNAVAILABLE.
 * - The customer's group discount (POS only) is auto-applied when no
 *   explicit discount was given; an unavailable group discount is
 *   silently skipped (a group discount that lapses must not fail sales).
 * - Coupon limits (maxUses / perCustomerUses / minSubtotal /
 *   firstOrderOnly) are enforced here too; see assertCouponEligible.
 *
 * The amount is ALWAYS computed server-side — a client never sends a
 * money value for a managed discount. PERCENTAGE rounds to 2 dp;
 * FIXED is capped so the total never goes below zero.
 * ============================================================
 */

export interface ResolvedDiscount {
  id: string;
  name: string;
  type: "PERCENTAGE" | "FIXED";
  value: Prisma.Decimal;
}

type DiscountQueryClient = Pick<Prisma.TransactionClient, "discount" | "customer">;

interface DiscountRowForApply {
  id: string;
  name: string;
  type: "PERCENTAGE" | "FIXED";
  value: Prisma.Decimal;
  isActive: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}

/** A discount only applies while active and inside its validity window. */
export function isDiscountAvailable(discount: DiscountRowForApply, now: Date): boolean {
  if (!discount.isActive) return false;
  if (discount.startsAt !== null && discount.startsAt > now) return false;
  if (discount.endsAt !== null && discount.endsAt <= now) return false;
  return true;
}

/**
 * Resolves an explicit discount by id or code (exactly one of the two).
 * Throws 404 when the discount does not exist in the store and 400 when
 * it exists but is not currently applicable.
 */
export async function resolveExplicitDiscount(
  client: DiscountQueryClient,
  storeId: string,
  explicit: { discountId?: string | null; discountCode?: string | null },
  now: Date = new Date(),
): Promise<ResolvedDiscount | null> {
  const { discountId, discountCode } = explicit;
  const idValue = discountId ?? undefined;
  const codeValue = discountCode ?? undefined;
  if (idValue === undefined && codeValue === undefined) return null;
  if (idValue !== undefined && codeValue !== undefined) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "discountId and discountCode are mutually exclusive",
    );
  }

  const where: Prisma.DiscountWhereInput =
    idValue !== undefined
      ? { id: idValue, storeId }
      : { storeId, code: codeValue!.trim().toUpperCase() };
  const row = await client.discount.findFirst({ where });
  if (row === null) {
    throw new AppError(404, "DISCOUNT_NOT_FOUND", "Discount not found");
  }
  if (!isDiscountAvailable(row, now)) {
    throw new AppError(
      400,
      "DISCOUNT_UNAVAILABLE",
      "This discount is not active or is outside its validity window",
    );
  }
  return { id: row.id, name: row.name, type: row.type, value: row.value };
}

/**
 * Resolves the customer's group auto-applied discount (POS only). A
 * customer without a group, or whose group has no attached discount (or
 * one that is currently unavailable), yields null — never an error.
 */
export async function resolveGroupDiscount(
  client: DiscountQueryClient,
  storeId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<ResolvedDiscount | null> {
  const row = await client.customer.findFirst({
    where: { id: customerId, storeId },
    select: {
      group: {
        select: { discount: { select: { id: true, name: true, type: true, value: true } } },
      },
    },
  });
  const discount = row?.group?.discount;
  if (discount === null || discount === undefined) return null;
  const groupDiscount = await client.discount.findUnique({
    where: { id: discount.id },
  });
  if (groupDiscount === null || !isDiscountAvailable(groupDiscount, now)) return null;
  return {
    id: groupDiscount.id,
    name: groupDiscount.name,
    type: groupDiscount.type,
    value: groupDiscount.value,
  };
}

/**
 * Computes the discount amount from the pre-discount line total.
 * PERCENTAGE rounds to 2 dp (half-up); the result never exceeds the line
 * total. FIXED applies its value, capped so the total never goes below
 * zero.
 */
export function computeDiscountAmount(
  discount: ResolvedDiscount,
  lineTotal: Prisma.Decimal,
): Prisma.Decimal {
  if (discount.type === "PERCENTAGE") {
    const amount = lineTotal.mul(discount.value).div(100);
    const rounded = amount.mul(100).round().div(100);
    return Prisma.Decimal.min(rounded, lineTotal);
  }
  return Prisma.Decimal.min(discount.value, lineTotal);
}

/**
 * Coupon eligibility client surface (a transaction client works).
 */
type CouponClient = Pick<Prisma.TransactionClient, "discount" | "couponRedemption" | "order">;

interface CouponRuleRow {
  id: string;
  maxUses: number | null;
  perCustomerUses: number | null;
  minSubtotal: Prisma.Decimal | null;
  firstOrderOnly: boolean | null;
}

const COUPON_ERRORS = {
  exhausted: () => new AppError(400, "COUPON_EXHAUSTED", "This coupon has been fully redeemed"),
  alreadyUsed: () => new AppError(400, "COUPON_ALREADY_USED", "This coupon has already been used"),
  minSubtotal: (min: Prisma.Decimal) =>
    new AppError(
      400,
      "COUPON_MIN_SUBTOTAL",
      `This coupon requires a minimum order of ₦${min.toString()}`,
    ),
  firstOrderOnly: () =>
    new AppError(400, "COUPON_FIRST_ORDER_ONLY", "This coupon is for first orders only"),
} as const;

/**
 * A discount is a COUPON when it carries a coupon rule. perCustomerUses
 * is deliberately NOT a signal: the column defaults to 1 for every
 * discount, so its presence alone cannot distinguish a plain discount
 * from a coupon. It only tunes the per-customer cap once another rule
 * marks the discount as a coupon. Enforced inside the same transaction
 * that creates the order, so a redemption row can never be orphaned by
 * a failed sale.
 */
function hasCouponRules(discount: CouponRuleRow): boolean {
  return (
    discount.maxUses !== null || discount.minSubtotal !== null || discount.firstOrderOnly !== null
  );
}

/**
 * Validates coupon rules for a sale: global cap (maxUses), per-customer
 * cap (perCustomerUses, default 1), minimum subtotal, and first-order-only.
 * Returns true when the discount IS a coupon (the caller must then record
 * a CouponRedemption row); false for a plain discount. Throws the
 * COUPON_* errors when a rule is violated. Runs on a transaction client
 * (or the prisma client in unit contexts).
 */
export async function assertCouponEligible(
  client: CouponClient,
  storeId: string,
  discountId: string,
  customerId: string,
  subtotal: Prisma.Decimal,
  now: Date = new Date(),
): Promise<boolean> {
  const discount = await client.discount.findUnique({
    where: { id: discountId },
    select: {
      id: true,
      storeId: true,
      maxUses: true,
      perCustomerUses: true,
      minSubtotal: true,
      firstOrderOnly: true,
    },
  });
  if (discount === null || discount.storeId !== storeId) {
    throw new AppError(404, "DISCOUNT_NOT_FOUND", "Discount not found");
  }
  if (!hasCouponRules(discount)) return false;
  void now;

  if (discount.maxUses !== null) {
    const used = await client.couponRedemption.count({
      where: { discountId, storeId },
    });
    if (used >= discount.maxUses) throw COUPON_ERRORS.exhausted();
  }

  const perCustomer = discount.perCustomerUses ?? 1;
  if (perCustomer > 0) {
    const usedByCustomer = await client.couponRedemption.count({
      where: { discountId, storeId, customerId },
    });
    if (usedByCustomer >= perCustomer) throw COUPON_ERRORS.alreadyUsed();
  }

  if (discount.minSubtotal !== null && subtotal.lt(discount.minSubtotal)) {
    throw COUPON_ERRORS.minSubtotal(discount.minSubtotal);
  }

  if (discount.firstOrderOnly === true) {
    const priorOrders = await client.order.count({ where: { storeId, customerId } });
    if (priorOrders > 0) throw COUPON_ERRORS.firstOrderOnly();
  }

  return true;
}

/**
 * Records a coupon use. Called by the sale flow INSIDE the same
 * transaction that creates the order, so a redemption row dies with its
 * order and can never exist for a failed sale.
 */
export async function createCouponRedemption(
  client: CouponClient,
  data: { storeId: string; discountId: string; orderId: string; customerId: string },
): Promise<unknown> {
  return client.couponRedemption.create({ data });
}
