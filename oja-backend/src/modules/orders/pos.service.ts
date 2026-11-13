import type { $Enums } from "../../../generated/prisma/client.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { logStoreActivity } from "../activity/service.js";
import { ensureDefaultGroup } from "../customer-groups/service.js";
import {
  assertCouponEligible,
  computeDiscountAmount,
  createCouponRedemption,
  resolveExplicitDiscount,
  resolveGroupDiscount,
  type ResolvedDiscount,
} from "../discounts/apply.js";
import { recordSaleStockChanges } from "../products/ledger.service.js";
import { enforceOrderCap } from "../subscriptions/service.js";
import { sendCustomerReceiptWithDefault } from "../receipts/service.js";
import { NOTIFICATION_REF_TYPES } from "../notifications/service.js";
import { AppError } from "../../lib/AppError.js";
import type { PaymentProvider, ProviderFactory } from "../../lib/paymentProvider.js";
import { PaymentProviderError } from "../../lib/paymentProvider.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { decryptSecret } from "../../lib/secrets.js";
import {
  aggregateCartItems,
  assertCartAvailable,
  defaultProviderFactory,
  effectiveUnitPrice,
  generatePaymentReference,
  loadCartContext,
} from "./service.js";
import { nextOrderNumber } from "./numbering.js";
import { posSaleSchema, validateOrThrow, type PosSaleInput } from "./schemas.js";

/**
 * ============================================================
 * POS RECORD-SALE (POST /api/dashboard/orders)
 * ============================================================
 * Merchants record sales at the register for a walk-in or known
 * customer. Pricing and stock rules are identical to public checkout —
 * the cart context helpers are shared (see orders/service.ts): prices
 * are never client-supplied, variants must be named when a product has
 * them, and availability is asserted before any write.
 *
 * The `branchId` picks the branch whose stock the sale decrements
 * (default: the store's default branch) — the checkout flow always
 * decrements the store default branch; the register may sell from any
 * of them (e.g. the Online Store branch is itself a branch).
 *
 * PAYMENT METHODS — two families (dashboard-pos.md):
 *   CASH / TRANSFER / CREDIT  — recorded PAID immediately in ONE
 *     transaction: guarded ledger decrement (never negative; a failed
 *     conditional UPDATE rolls the whole sale back), order row, line
 *     items, and audit entries are atomic. CREDIT keeps amountPaid (0.00
 *     default); balance due = total - amountPaid feeds the later credit
 *     repayments feature.
 *   CARD — the order is created PENDING and the existing Paystack
 *     hosted-checkout flow takes over: the charge.success webhook makes
 *     it PAID and decrements stock. Stock is NOT held for a PENDING card
 *     order. A provider failure leaves a CANCELLED order and throws 502.
 *
 * The acting staff member is attributed via soldByStaffId (canonical
 * source for staff-performance analytics). The order cap is enforced
 * identically to checkout.
 * ============================================================
 */

/** Name of the shared per-store row used for anonymous walk-in sales. */
export const WALK_IN_CUSTOMER_NAME = "Walk-in Customer";

export interface PosSaleResult {
  order: {
    id: string;
    orderNumber: string;
    status: $Enums.OrderStatus;
    total: string;
    discountAmount: string;
    discountId: string | null;
    amountPaid: string | null;
    balanceDue: string;
    paymentMethod: $Enums.PaymentMethod;
    source: $Enums.OrderSource;
    createdAt: Date;
  };
  payment: { provider: string; reference: string; redirectUrl: string } | null;
}

export async function recordPosSale(
  storeId: string,
  staffMemberId: string | undefined,
  input: unknown,
  providerFactory: ProviderFactory = defaultProviderFactory,
): Promise<PosSaleResult> {
  const data: PosSaleInput = validateOrThrow(posSaleSchema, input);
  const prisma = getPrismaClient();

  await enforceOrderCap(storeId);

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { defaultBranchId: true },
  });
  if (store === null) {
    throw new AppError(404, "NOT_FOUND", "Store not found");
  }
  const branchId = data.branchId ?? store.defaultBranchId;
  if (branchId === null) {
    throw new AppError(
      409,
      "STORE_NOT_CONFIGURED",
      "This store has no default branch — create one before recording sales",
    );
  }
  const branch = await prisma.branch.findFirst({
    where: { id: branchId, storeId },
    select: { id: true, name: true },
  });
  if (branch === null) {
    throw new AppError(404, "BRANCH_NOT_FOUND", "Branch not found");
  }

  const quantities = aggregateCartItems(data.items);
  const ctx = await loadCartContext(storeId, branchId, quantities);
  assertCartAvailable(quantities, ctx);

  const customer = await resolveCustomer(prisma, storeId, data.customerId);

  const paymentMethod = data.paymentMethod;

  const lineTotal = [...quantities.values()].reduce(
    (sum, entry) => sum.add(effectiveUnitPrice(entry, ctx).mul(entry.quantity)),
    new Prisma.Decimal(0),
  );

  // Managed discount resolution: an explicit id/code wins; otherwise the
  // customer's group discount auto-applies; otherwise none. The amount is
  // computed server-side and never exceeds the line total.
  const { discount, fromExplicit } = await resolveSaleDiscount(prisma, storeId, customer.id, data);
  const discountAmount =
    discount === null ? new Prisma.Decimal(0) : computeDiscountAmount(discount, lineTotal);
  const total = lineTotal.sub(discountAmount);

  if (paymentMethod === "CARD") {
    return recordCardSale(prisma, {
      storeId,
      branchId,
      customerId: customer.id,
      customerEmail: customer.email,
      data,
      staffMemberId,
      discountAmount,
      discountId: discount?.id ?? null,
      fromExplicit,
      lineTotal,
      total,
      quantities,
      ctx,
      providerFactory,
    });
  }

  // CASH / TRANSFER / CREDIT — the instant path.
  const amountPaid = resolveInstantAmountPaid(paymentMethod, data.amountPaid, total);

  const order = await prisma.$transaction(async (tx) => {
    // Coupon rules (maxUses / perCustomerUses / minSubtotal /
    // firstOrderOnly) are enforced before any write so a failed sale
    // never mutates stock; the redemption row lands in the same
    // transaction as the order (no orphans). Group auto-discounts are
    // never coupons and skip this entirely.
    const isCoupon =
      fromExplicit && discount !== null
        ? await assertCouponEligible(tx, storeId, discount.id, customer.id, lineTotal)
        : false;
    await recordSaleStockChanges(
      tx,
      [...quantities.values()].map((entry) => ({
        storeId,
        branchId,
        productId: entry.productId,
        variantId: entry.variantId ?? undefined,
        quantityChange: -entry.quantity,
        performedByStaffId: staffMemberId ?? undefined,
      })),
    );
    const created = await tx.order.create({
      data: {
        storeId,
        branchId,
        customerId: customer.id,
        orderNumber: await nextOrderNumber(tx, storeId),
        status: "PAID",
        paidAt: new Date(),
        total,
        discountAmount,
        discountId: discount?.id ?? null,
        paymentMethod,
        amountPaid,
        source: "POS",
        soldByStaffId: staffMemberId ?? null,
        receiptEmail: customer.email ?? data.email ?? null,
      },
    });
    if (isCoupon) {
      await createCouponRedemption(tx, {
        storeId,
        discountId: discount!.id,
        orderId: created.id,
        customerId: customer.id,
      });
    }
    await tx.orderLineItem.createMany({
      data: [...quantities.values()].map((entry) => ({
        storeId,
        orderId: created.id,
        productId: entry.productId,
        variantId: entry.variantId,
        quantity: entry.quantity,
        unitPriceAtPurchase: effectiveUnitPrice(entry, ctx),
      })),
    });
    await logStoreActivity(tx, {
      storeId,
      staffMemberId: staffMemberId ?? null,
      action: "sale.recorded",
      detail: {
        orderId: created.id,
        branchId,
        branchName: branch.name,
        paymentMethod,
        total: total.toFixed(2),
        discountAmount: discountAmount.toFixed(2),
        amountPaid: amountPaid.toFixed(2),
      },
    });
    return created;
  });

  // Best-effort customer receipt; fire-and-forget so the POS response is
  // never blocked by an email round-trip. Skipped with no recipient email.
  void sendCustomerReceiptWithDefault(storeId, NOTIFICATION_REF_TYPES.ORDER, order.id);

  return {
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      status: "PAID",
      total: total.toFixed(2),
      discountAmount: discountAmount.toFixed(2),
      discountId: discount?.id ?? null,
      amountPaid: amountPaid.toFixed(2),
      balanceDue: paymentMethod === "CREDIT" ? total.sub(amountPaid).toFixed(2) : "0.00",
      paymentMethod,
      source: "POS",
      createdAt: order.createdAt,
    },
    payment: null,
  };
}

function resolveInstantAmountPaid(
  paymentMethod: $Enums.PaymentMethod,
  amountPaid: string | undefined,
  total: Prisma.Decimal,
): Prisma.Decimal {
  const paid = new Prisma.Decimal(
    amountPaid ?? (paymentMethod === "CREDIT" ? "0" : total.toString()),
  );
  if (paid.gt(total)) {
    throw new AppError(400, "VALIDATION_ERROR", "Paid amount can't exceed the order total");
  }
  return paid;
}

/** The named customer (verified tenant-owned) or the lazy shared walk-in row. */
async function resolveCustomer(
  prisma: ReturnType<typeof getPrismaClient>,
  storeId: string,
  customerId: string | undefined,
): Promise<{ id: string; email: string | null }> {
  if (customerId !== undefined) {
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, storeId },
      select: { id: true, email: true },
    });
    if (customer === null) {
      throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
    }
    return customer;
  }
  const existing = await prisma.customer.findFirst({
    where: { storeId, name: WALK_IN_CUSTOMER_NAME },
    select: { id: true, email: true },
  });
  if (existing !== null) {
    return existing;
  }
  // New implicit customers land in the store's default "General" group.
  const generalGroupId = await ensureDefaultGroup(prisma, storeId);
  return prisma.customer.create({
    data: { storeId, name: WALK_IN_CUSTOMER_NAME, groupId: generalGroupId, source: "POS" },
    select: { id: true, email: true },
  });
}

/**
 * Resolves the discount for a POS sale: an explicit id/code wins,
 * otherwise the customer's group discount auto-applies, otherwise null.
 * Explicit discounts validate strictly (404/400); an unavailable group
 * discount is silently skipped so lapsed group pricing never blocks a
 * sale. `fromExplicit` marks a discount that came from an id/code — the
 * only kind that can be a coupon (group discounts are rules, never
 * tracked).
 */
async function resolveSaleDiscount(
  prisma: ReturnType<typeof getPrismaClient>,
  storeId: string,
  customerId: string,
  data: PosSaleInput,
): Promise<{ discount: ResolvedDiscount | null; fromExplicit: boolean }> {
  const fromExplicit = data.discountId !== undefined || data.discountCode !== undefined;
  const explicit = await resolveExplicitDiscount(prisma, storeId, {
    discountId: data.discountId,
    discountCode: data.discountCode,
  });
  if (explicit !== null) return { discount: explicit, fromExplicit: true };
  return { discount: await resolveGroupDiscount(prisma, storeId, customerId), fromExplicit };
}

interface CardSaleContext {
  storeId: string;
  branchId: string;
  customerId: string;
  customerEmail: string | null;
  data: PosSaleInput;
  staffMemberId: string | undefined;
  discountAmount: Prisma.Decimal;
  discountId: string | null;
  fromExplicit: boolean;
  lineTotal: Prisma.Decimal;
  total: Prisma.Decimal;
  quantities: ReturnType<typeof aggregateCartItems>;
  ctx: Awaited<ReturnType<typeof loadCartContext>>;
  providerFactory: ProviderFactory;
}

/**
 * The CARD path: order created PENDING, Paystack hosted checkout
 * initiated for the total. Paystack requires an email for receipting —
 * the customer's own email wins, the request's `email` override backs it
 * up; neither → 400. Any provider failure leaves a CANCELLED order (the
 * trace of what was attempted) and throws 502. The webhook completes the
 * PENDING→PAID transition + stock decrement.
 */
async function recordCardSale(
  prisma: ReturnType<typeof getPrismaClient>,
  ctx: CardSaleContext,
): Promise<PosSaleResult> {
  const credential = await prisma.paymentCredential.findUnique({
    where: { storeId_provider: { storeId: ctx.storeId, provider: "paystack" } },
  });
  if (credential === null) {
    throw new AppError(
      409,
      "PAYMENT_NOT_CONFIGURED",
      "This store has not configured a payment provider yet",
    );
  }

  const receiptEmail = (ctx.customerEmail ?? ctx.data.email)?.toLowerCase();
  if (receiptEmail === undefined) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "A CARD payment needs an email for the receipt — provide the customer's email or an email field",
    );
  }

  const paymentReference = generatePaymentReference();

  const order = await prisma.$transaction(async (tx) => {
    // Coupon rules are enforced before the order write; the redemption
    // row lands in the same transaction (no orphans). A PENDING card
    // order counts as a use at initiation — the buyer committed to the
    // code; a later provider failure cancels the order and its
    // redemption cascades with it.
    const isCoupon =
      ctx.fromExplicit && ctx.discountId !== null
        ? await assertCouponEligible(tx, ctx.storeId, ctx.discountId, ctx.customerId, ctx.lineTotal)
        : false;
    const created = await tx.order.create({
      data: {
        storeId: ctx.storeId,
        branchId: ctx.branchId,
        customerId: ctx.customerId,
        orderNumber: await nextOrderNumber(tx, ctx.storeId),
        status: "PENDING",
        total: ctx.total,
        discountAmount: ctx.discountAmount,
        discountId: ctx.discountId,
        paymentMethod: "CARD",
        amountPaid: null,
        source: "POS",
        soldByStaffId: ctx.staffMemberId ?? null,
        paymentProvider: credential.provider,
        paymentReference,
        receiptEmail: receiptEmail,
      },
    });
    if (isCoupon && ctx.discountId !== null) {
      await createCouponRedemption(tx, {
        storeId: ctx.storeId,
        discountId: ctx.discountId,
        orderId: created.id,
        customerId: ctx.customerId,
      });
    }
    await tx.orderLineItem.createMany({
      data: [...ctx.quantities.values()].map((entry) => ({
        storeId: ctx.storeId,
        orderId: created.id,
        productId: entry.productId,
        variantId: entry.variantId,
        quantity: entry.quantity,
        unitPriceAtPurchase: effectiveUnitPrice(entry, ctx.ctx),
      })),
    });
    return created;
  });

  const provider = ctx.providerFactory({
    publicKey: credential.publicKey,
    secretKey: decryptSecret(credential.secretKeyEncrypted),
  });

  let initiation: Awaited<ReturnType<PaymentProvider["initiateCheckout"]>>;
  try {
    initiation = await provider.initiateCheckout({
      amount: ctx.total.toString(),
      currency: "NGN",
      email: receiptEmail,
      reference: paymentReference,
      metadata: { orderId: order.id },
    });
  } catch (err) {
    // A failed initiation leaves a CANCELLED order — never a PENDING row
    // that looks payable without a live checkout session.
    await prisma.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    if (err instanceof PaymentProviderError) {
      throw new AppError(
        502,
        "PAYMENT_PROVIDER_ERROR",
        "The payment provider could not complete the sale — try again shortly",
        err.message,
      );
    }
    throw err;
  }

  await prisma.order.update({
    where: { id: order.id },
    data: { authorizationUrl: initiation.authorizationUrl },
  });

  return {
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      status: "PENDING",
      total: ctx.total.toFixed(2),
      discountAmount: ctx.discountAmount.toFixed(2),
      discountId: ctx.discountId,
      amountPaid: null,
      balanceDue: "0.00",
      paymentMethod: "CARD",
      source: "POS",
      createdAt: order.createdAt,
    },
    payment: {
      provider: credential.provider,
      reference: paymentReference,
      redirectUrl: initiation.authorizationUrl,
    },
  };
}
