import type { $Enums } from "../../../generated/prisma/client.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import type {
  CheckoutInitiationInput,
  PaymentProvider,
  ProviderFactory,
} from "../../lib/paymentProvider.js";
import { PaymentProviderError } from "../../lib/paymentProvider.js";
import { createPaystackProvider } from "../../lib/providers/paystack.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { decryptSecret } from "../../lib/secrets.js";
import { env } from "../../config/env.js";
import { ensureDefaultGroup } from "../customer-groups/service.js";
import { computeDiscountAmount, resolveExplicitDiscount } from "../discounts/apply.js";
import { nextOrderNumber } from "./numbering.js";
import { assertCouponEligible, createCouponRedemption } from "../discounts/apply.js";
import { enforceOrderCap } from "../subscriptions/service.js";
import { markOrderPaidAndDecrementStock } from "../webhooks/service.js";
import { defaultAlertSender } from "../notifications/email.js";
import {
  notifyPaymentClaimed,
  notifyPaymentReceived,
  NOTIFICATION_REF_TYPES,
} from "../notifications/service.js";
import { sendCustomerReceiptWithDefault } from "../receipts/service.js";
import {
  checkoutSchema,
  validateOrThrow,
  type CheckoutInput,
  type ListOrdersParams,
} from "./schemas.js";
import { verifyShipbubbleCheckoutQuote, type SelectedShipbubbleRate } from "./shipbubble.service.js";

/**
 * ============================================================
 * PUBLIC CHECKOUT — ORDER CREATION (initiation only)
 * ============================================================
 *
 * initiateCheckout is the ONLY way an Order is created from a public
 * cart. It resolves nothing about the tenant itself — the store has
 * already been resolved from the subdomain by the resolvePublicStore
 * middleware; this service trusts `storeId`.
 *
 * STOCK — DELIBERATELY NOT DECREMENTED HERE
 * ------------------------------------------
 * Initiation checks availability and rejects an oversold cart with
 * INSUFFICIENT_STOCK, but it never writes a ledger entry and never
 * decrements Product.quantity. The stock check is therefore advisory:
 * a concurrent sale could consume stock after the check passes. This is
 * by design — the authoritative, atomic decrement (conditional UPDATE +
 * SALE ledger entry) happens ONLY inside the payment-confirmation
 * transaction (Phase 9), where money has actually arrived. Order stays
 * PENDING until then; a PENDING order holds no stock.
 *
 * FAILURE HANDLING
 * ----------------
 * The Order row is created BEFORE the provider call so that a provider
 * failure (bad keys, API outage) leaves a CANCELLED order — the trace
 * of what was attempted — never a dangling PENDING row. Delivery of the
 * redirect URL is the contract of success; failure throws 502
 * PAYMENT_PROVIDER_ERROR with a generic message (provider details stay
 * internal).
 *
 * The provider is injected through `providerFactory` (default: Paystack
 * built from the store's decrypted credentials) so unit tests substitute
 * a fake without network, mirroring the InviteEmailSender pattern.
 * ============================================================
 */

export interface CheckoutResult {
  order: {
    id: string;
    orderNumber: string;
    total: string;
    discountAmount: string;
    discountId: string | null;
    status: $Enums.OrderStatus;
    delivery: {
      kind: $Enums.DeliveryKind;
      optionName: string;
      fee: string;
      provider: "manual" | "shipbubble";
      courierName: string | null;
    } | null;
  };
  payment: {
    provider: string;
    reference: string;
    redirectUrl: string;
    bankDetails?: {
      bankName: string;
      accountName: string;
      accountNumber: string;
      reference: string;
    };
  };
}

/** Builds a provider from stored (decrypted) credentials. (Shared contract in lib/paymentProvider.ts.) */
export type { ProviderFactory } from "../../lib/paymentProvider.js";

export const defaultProviderFactory: ProviderFactory = ({ publicKey, secretKey }) =>
  createPaystackProvider({ publicKey, secretKey });

/**
 * ============================================================
 * SHARED CART CONTEXT (public checkout + POS record-sale)
 * ============================================================
 * Both sale entry points resolve the cart the same way: aggregate line
 * items, load the sellable catalog + the branch stock, validate
 * availability, and price each line. Loading from the branch-of-record
 * (checkout: the store default branch; POS: the chosen branch).
 */

export interface CartEntry {
  productId: string;
  variantId: string | null;
  quantity: number;
}

export type SaleCartItem = {
  productId: string;
  variantId?: string;
  quantity: number;
};

export function cartEntryKey(entry: CartEntry): string {
  return `${entry.productId}:${entry.variantId ?? ""}`;
}

export function aggregateCartItems(items: SaleCartItem[]): Map<string, CartEntry> {
  const quantities = new Map<string, CartEntry>();
  for (const item of items) {
    const key = `${item.productId}:${item.variantId ?? ""}`;
    const entry = quantities.get(key) ?? {
      productId: item.productId,
      variantId: item.variantId ?? null,
      quantity: 0,
    };
    entry.quantity += item.quantity;
    quantities.set(key, entry);
  }
  return quantities;
}

type ProductForSale = Prisma.ProductGetPayload<{
  include: { variants: { select: { id: true; archivedAt: true } } };
}>;

export interface CartContext {
  byId: Map<string, ProductForSale>;
  byVariantId: Map<
    string,
    { id: string; productId: string; name: string; sellingPrice: Prisma.Decimal | null }
  >;
  byBranchStock: Map<string, { productId: string; variantId: string | null; quantity: number }>;
}

/**
 * Loads the sellable catalog and the branch's stock for a cart. The
 * catalog gate: only PUBLISHED, non-deleted products are buyable —
 * DRAFT products are simply absent from `byId`, so the availability
 * check classifies them exactly like deleted products
 * (PRODUCT_UNAVAILABLE): one code path, one classification.
 */
export async function loadCartContext(
  storeId: string,
  branchId: string,
  quantities: Map<string, CartEntry>,
): Promise<CartContext> {
  const prisma = getPrismaClient();
  const productIds = [...quantities.keys()].map((key) => key.split(":")[0]!);

  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, storeId, status: "PUBLISHED", deletedAt: null },
    include: { variants: { select: { id: true, archivedAt: true } } },
  });

  // Only ACTIVE variants are sellable — an archived variant is treated as
  // not available (the storefront hides it too).
  const variants = await prisma.productVariant.findMany({
    where: { productId: { in: productIds }, storeId, archivedAt: null },
    select: { id: true, productId: true, name: true, sellingPrice: true },
  });

  // BranchStock rows are the authoritative per-branch numbers; the
  // guarded decrement later operates on the same rows.
  const branchStocks = await prisma.branchStock.findMany({
    where: { branchId, productId: { in: productIds } },
    select: { productId: true, variantId: true, quantity: true },
  });

  return {
    byId: new Map(products.map((product) => [product.id, product])),
    byVariantId: new Map(variants.map((variant) => [variant.id, variant])),
    byBranchStock: new Map(
      branchStocks.map((row) => [`${row.productId}:${row.variantId ?? ""}`, row]),
    ),
  };
}

/**
 * Validates every cart line against the loaded context — throws before
 * any write: PRODUCT_UNAVAILABLE for unknown/DRAFT/deleted products,
 * VARIANT_REQUIRED / VARIANT_NOT_FOUND for variant mismatches,
 * INSUFFICIENT_STOCK when the branch cannot cover a line.
 */
export function assertCartAvailable(quantities: Map<string, CartEntry>, ctx: CartContext): void {
  for (const entry of quantities.values()) {
    const product = ctx.byId.get(entry.productId);
    if (product === undefined || product.deletedAt !== null) {
      throw new AppError(
        409,
        "PRODUCT_UNAVAILABLE",
        "One of the products in the cart is no longer available — please refresh the cart",
      );
    }
    if (entry.variantId !== null) {
      // A variant product MUST be selected per variant — never as a
      // single stock number.
      if (product.variants.length === 0) {
        throw new AppError(400, "VARIANT_NOT_FOUND", "This product has no variants");
      }
      const variant = ctx.byVariantId.get(entry.variantId);
      if (variant === undefined || variant.productId !== product.id) {
        // Unknown, other-product, or archived — indistinguishable to the
        // buyer so a retired variant never leaks.
        throw new AppError(
          409,
          "PRODUCT_UNAVAILABLE",
          "One of the items in the cart is no longer available — please refresh the cart",
        );
      }
      const available = ctx.byBranchStock.get(cartEntryKey(entry))?.quantity ?? 0;
      if (available < entry.quantity) {
        throw new AppError(
          409,
          "INSUFFICIENT_STOCK",
          `Only ${available} of "${product.name}" (${ctx.byVariantId.get(entry.variantId)!.name}) remain — adjust the quantity and try again`,
        );
      }
    } else if (product.variants.length > 0) {
      // The product is variant-based. If every variant is archived there is
      // nothing to buy — surface it as unavailable, not "choose a variant".
      if (product.variants.every((v) => v.archivedAt !== null)) {
        throw new AppError(
          409,
          "PRODUCT_UNAVAILABLE",
          "One of the products in the cart is no longer available — please refresh the cart",
        );
      }
      throw new AppError(400, "VARIANT_REQUIRED", `"${product.name}" requires choosing a variant`);
    } else {
      const available = ctx.byBranchStock.get(cartEntryKey(entry))?.quantity ?? 0;
      if (available < entry.quantity) {
        throw new AppError(
          409,
          "INSUFFICIENT_STOCK",
          `Only ${available} of "${product.name}" remain — adjust the quantity and try again`,
        );
      }
    }
  }
}

/**
 * Per-entry effective unit price: the variant's sellingPrice when the
 * line names a variant (falling back to the product's price), else the
 * product's price. The product's discountPrice — when set — is the
 * effective price for variant-less lines and the fallback under a
 * variant without its own sellingPrice.
 */
export function effectiveUnitPrice(entry: CartEntry, ctx: CartContext): Prisma.Decimal {
  return entry.variantId === null
    ? (ctx.byId.get(entry.productId)!.discountPrice ?? ctx.byId.get(entry.productId)!.price)
    : (ctx.byVariantId.get(entry.variantId)!.sellingPrice ??
        ctx.byId.get(entry.productId)!.discountPrice ??
        ctx.byId.get(entry.productId)!.price);
}

/**
 * Fresh, human-readable, provider-agnostic order reference. "BRK-" brands
 * it as a manual bank-transfer reference (vs the old provider-only ord_),
 * and the 10 base36 chars keep it short for customers typing it into a
 * transfer narration. Uniqueness is enforced by @@unique([storeId,
 * paymentReference]); callers retry on collision.
 */
export function generatePaymentReference(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";
  for (let i = 0; i < 10; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `BRK-${suffix}`;
}

export async function initiateCheckout(
  storeId: string,
  input: unknown,
  providerFactory: ProviderFactory = defaultProviderFactory,
  currency: CheckoutInitiationInput["currency"] = "NGN",
): Promise<CheckoutResult> {
  const data: CheckoutInput = validateOrThrow(checkoutSchema, input);
  // Plan gate: a store with a subscription at/over its billing-period orderCap
  // cannot initiate more orders (409 ORDER_LIMIT_REACHED). No subscription or
  // a null orderCap means unlimited — the store is unaffected.
  await enforceOrderCap(storeId);
  const prisma = getPrismaClient();

  // The order will draw its stock from the store's default branch
  // (resolved again atomically at payment confirmation, from the order's
  // own branchId). A store without a default branch cannot sell.
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { defaultBranchId: true },
  });
  if (store === null) {
    throw new AppError(404, "NOT_FOUND", "Store not found");
  }
  if (store.defaultBranchId === null) {
    throw new AppError(
      409,
      "STORE_NOT_CONFIGURED",
      "This store has no default branch — create one before accepting orders",
    );
  }
  const branchId = store.defaultBranchId;

  // Aggregate duplicate entries so stock checks and line items are exact.
  // The key is (productId, variantId): two lines of the same variant
  // combine; different variants of the same product stay separate.
  const quantities = aggregateCartItems(data.items);

  // The catalog gate, the variant rules, and the ADVISORY stock check all
  // live in the shared cart context — see assertCartAvailable above.
  // Payment confirmation does the real guarded decrement on the same
  // BranchStock rows; the check here only gives the customer an early,
  // friendly failure before paying.
  const ctx = await loadCartContext(storeId, branchId, quantities);
  assertCartAvailable(quantities, ctx);

  const paymentMethod: "paystack" | "bank_transfer" = data.paymentMethod ?? "paystack";

  // Bank-transfer checkouts need a merchant bank account but NO payment
  // provider. Paystack checkouts need a configured provider credential.
  let paymentProvider: string;
  let bankSnapshot: {
    bankAccountId: string;
    bankName: string;
    accountName: string;
    accountNumber: string;
  } | null = null;
  if (paymentMethod === "bank_transfer") {
    const bank = await prisma.bankAccount.findFirst({
      where: { storeId, isDefault: true },
      select: { id: true, bankName: true, accountName: true, accountNumber: true },
    });
    if (bank === null || bank.accountNumber === null) {
      throw new AppError(
        409,
        "BANK_ACCOUNT_NOT_CONFIGURED",
        "This store has not configured a bank account for transfers yet",
      );
    }
    paymentProvider = "bank_transfer";
    bankSnapshot = {
      bankAccountId: bank.id,
      bankName: bank.bankName,
      accountName: bank.accountName,
      accountNumber: bank.accountNumber,
    };
  } else {
    const credential = await prisma.paymentCredential.findUnique({
      where: { storeId_provider: { storeId, provider: "paystack" } },
    });
    if (credential === null) {
      throw new AppError(
        409,
        "PAYMENT_NOT_CONFIGURED",
        "This store has not configured a payment provider yet",
      );
    }
    paymentProvider = credential.provider;
  }

  const customerEmail = data.customer.email.toLowerCase();
  let customer = await prisma.customer.findFirst({ where: { storeId, email: customerEmail } });
  if (customer === null) {
    // New implicit customers land in the store's default "General" group.
    const generalGroupId = await ensureDefaultGroup(prisma, storeId);
    customer = await prisma.customer.create({
      data: {
        storeId,
        name: data.customer.name,
        email: customerEmail,
        phone: data.customer.phone,
        source: "STOREFRONT",
        groupId: generalGroupId,
      },
    });
  }

  const lineTotal = [...quantities.values()].reduce(
    (sum, entry) => sum.add(effectiveUnitPrice(entry, ctx).mul(entry.quantity)),
    new Prisma.Decimal(0),
  );

  // Managed discount code (optional). An unavailable/unknown code is a
  // hard error at checkout — the buyer asked for it by name.
  const discount =
    data.discountCode === undefined
      ? null
      : await resolveExplicitDiscount(prisma, storeId, { discountCode: data.discountCode });
  const discountAmount =
    discount === null ? new Prisma.Decimal(0) : computeDiscountAmount(discount, lineTotal);

  // Fulfilment: when the store has active delivery options the buyer must
  // pick one. The fee is the option's own `baseFee` — read from the DB,
  // never taken from the client — and the option name + fee + (for a
  // DELIVERY option) the customer's address are frozen on the order.
  const activeOptionCount = await prisma.deliveryOption.count({
    where: { storeId, isActive: true },
  });
  let deliveryFee = new Prisma.Decimal(0);
  let deliverySnapshot: {
    deliveryOptionId: string;
    deliveryKind: "PICKUP" | "DELIVERY";
    deliveryOptionName: string;
    deliveryAddress: string | null;
    deliveryCity: string | null;
    deliveryState: string | null;
    deliveryPhone: string | null;
    deliveryInstructions: string | null;
    deliveryProvider: string;
    courierName?: string;
    shipbubbleCourierId?: string;
    shipbubbleServiceCode?: string;
    shipbubbleRateQuoteId?: string;
  } | null = null;
  let selectedShipbubbleRate: SelectedShipbubbleRate | null = null;

  if (data.deliveryOptionId === undefined) {
    if (data.shipbubbleQuoteId !== undefined || data.shipbubbleCourierId !== undefined || data.shipbubbleServiceCode !== undefined) {
      throw new AppError(400, "VALIDATION_ERROR", "Shipbubble quote fields require a delivery option");
    }
    if (activeOptionCount > 0) {
      throw new AppError(
        409,
        "DELIVERY_OPTION_REQUIRED",
        "Please choose a delivery option before checking out",
      );
    }
  } else {
    const option = await prisma.deliveryOption.findFirst({
      where: { id: data.deliveryOptionId, storeId, isActive: true },
      select: { id: true, kind: true, provider: true, name: true, baseFee: true },
    });
    if (option === null) {
      throw new AppError(
        404,
        "DELIVERY_OPTION_NOT_FOUND",
        "That delivery option is not available — please refresh and try again",
      );
    }
    // A DELIVERY option needs the customer's own address; a PICKUP option
    // collects nothing (the pickup location lives on the option itself).
    let address: string | null = null;
    let city: string | null = null;
    let state: string | null = null;
    let phone: string | null = null;
    let instructions: string | null = null;
    if (option.kind === "DELIVERY") {
      const missing: string[] = [];
      if (data.deliveryAddress === undefined) missing.push("address");
      if (data.deliveryCity === undefined) missing.push("city");
      if (data.deliveryState === undefined) missing.push("state");
      if (data.deliveryPhone === undefined) missing.push("phone number");
      if (missing.length > 0) {
        throw new AppError(
          400,
          "DELIVERY_DETAILS_REQUIRED",
          `Please provide your delivery ${missing.join(", ")}`,
        );
      }
      address = data.deliveryAddress!;
      city = data.deliveryCity!;
      state = data.deliveryState!;
      phone = data.deliveryPhone!;
      instructions = data.deliveryInstructions ?? null;
    }
    if (option.provider === "SHIPBUBBLE") {
      if (
        data.shipbubbleQuoteId === undefined ||
        data.shipbubbleCourierId === undefined ||
        data.shipbubbleServiceCode === undefined
      ) {
        throw new AppError(400, "SHIPBUBBLE_QUOTE_REQUIRED", "Choose a current Shipbubble courier quote before checkout");
      }
      const config = await prisma.shipbubbleStoreConfig.findUnique({ where: { storeId } });
      if (config === null) throw new AppError(409, "SHIPBUBBLE_NOT_CONFIGURED", "This store has not configured Shipbubble");
      selectedShipbubbleRate = await verifyShipbubbleCheckoutQuote({
        storeId,
        optionId: option.id,
        quoteId: data.shipbubbleQuoteId,
        courierId: data.shipbubbleCourierId,
        serviceCode: data.shipbubbleServiceCode,
        quantities,
        context: ctx,
        config,
        destination: {
          name: data.customer.name,
          email: data.customer.email,
          phone: phone!,
          address: address!,
          city: city!,
          state: state!,
          instructions: instructions ?? undefined,
        },
      });
      deliveryFee = new Prisma.Decimal(selectedShipbubbleRate.customerFee);
    } else {
      if (data.shipbubbleQuoteId !== undefined || data.shipbubbleCourierId !== undefined || data.shipbubbleServiceCode !== undefined) {
        throw new AppError(400, "VALIDATION_ERROR", "Shipbubble quote fields require a Shipbubble delivery option");
      }
      deliveryFee = option.baseFee;
    }
    deliverySnapshot = {
      deliveryOptionId: option.id,
      deliveryKind: option.kind,
      deliveryOptionName: selectedShipbubbleRate === null ? option.name : `${option.name} — ${selectedShipbubbleRate.courierName}`.slice(0, 200),
      deliveryAddress: address,
      deliveryCity: city,
      deliveryState: state,
      deliveryPhone: phone,
      deliveryInstructions: instructions,
      deliveryProvider: option.provider === "SHIPBUBBLE" ? "shipbubble" : "manual",
      ...(selectedShipbubbleRate === null ? {} : { courierName: selectedShipbubbleRate.courierName }),
      ...(selectedShipbubbleRate === null
        ? {}
        : {
            shipbubbleCourierId: selectedShipbubbleRate.courierId,
            shipbubbleServiceCode: selectedShipbubbleRate.serviceCode,
            shipbubbleRateQuoteId: selectedShipbubbleRate.quoteId,
          }),
    };
  }

  const total = lineTotal.sub(discountAmount).add(deliveryFee);
  const checkoutDelivery =
    deliverySnapshot === null
      ? null
      : {
          kind: deliverySnapshot.deliveryKind,
          optionName: deliverySnapshot.deliveryOptionName,
          fee: deliveryFee.toFixed(2),
          provider: deliverySnapshot.deliveryProvider as "manual" | "shipbubble",
          courierName: selectedShipbubbleRate?.courierName ?? null,
        };

  const paymentReference = generatePaymentReference();

  const order = await prisma.$transaction(async (tx) => {
    if (selectedShipbubbleRate !== null) {
      const consumed = await tx.shipbubbleRateQuote.updateMany({
        where: {
          id: selectedShipbubbleRate.quoteId,
          storeId,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) {
        throw new AppError(409, "SHIPBUBBLE_QUOTE_ALREADY_USED", "That delivery quote expired or was already used; request new rates");
      }
    }
    // Coupon rules (maxUses / perCustomerUses / minSubtotal /
    // firstOrderOnly) are enforced before the order write; the
    // redemption row lands in the same transaction (no orphans).
    const isCoupon =
      discount !== null
        ? await assertCouponEligible(tx, storeId, discount.id, customer.id, lineTotal)
        : false;
    const orderNumber = await nextOrderNumber(tx, storeId);
    const created = await tx.order.create({
      data: {
        storeId,
        branchId,
        customerId: customer.id,
        orderNumber,
        status: "PENDING",
        fulfillmentEvents: { create: { status: "ORDER_RECEIVED", source: "SYSTEM" } },
        total,
        discountAmount,
        discountId: discount?.id ?? null,
        source: data.origin ?? "STOREFRONT",
        paymentProvider,
        paymentReference,
        receiptEmail: customerEmail,
        deliveryFee,
        ...(deliverySnapshot ?? {}),
        bankAccountId: bankSnapshot?.bankAccountId ?? null,
        bankName: bankSnapshot?.bankName ?? null,
        accountName: bankSnapshot?.accountName ?? null,
        accountNumber: bankSnapshot?.accountNumber ?? null,
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
    return created;
  });

  // Bank transfer: no provider call. Return the frozen bank details and the
  // reference immediately — the customer pays manually, then the merchant
  // confirms. The order stays PENDING until mark-paid + confirm.
  if (paymentMethod === "bank_transfer" && bankSnapshot !== null) {
    return {
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        total: order.total.toString(),
        discountAmount: discountAmount.toFixed(2),
        discountId: discount?.id ?? null,
        status: "PENDING",
        delivery: checkoutDelivery,
      },
      payment: {
        provider: "bank_transfer",
        reference: paymentReference,
        redirectUrl: "",
        bankDetails: {
          bankName: bankSnapshot.bankName,
          accountName: bankSnapshot.accountName,
          accountNumber: bankSnapshot.accountNumber,
          reference: paymentReference,
        },
      },
    };
  }

  // Paystack path: the provider call is the contract of success.
  const credential = await prisma.paymentCredential.findUnique({
    where: { storeId_provider: { storeId, provider: "paystack" } },
  });
  if (credential === null) {
    throw new AppError(409, "PAYMENT_NOT_CONFIGURED", "Payment provider is not configured");
  }

  const provider = providerFactory({
    publicKey: credential.publicKey,
    secretKey: decryptSecret(credential.secretKeyEncrypted),
  });

  let initiation: Awaited<ReturnType<PaymentProvider["initiateCheckout"]>>;
  try {
    initiation = await provider.initiateCheckout({
      amount: order.total.toString(),
      currency,
      email: customerEmail,
      reference: paymentReference,
      metadata: { orderId: order.id },
    });
  } catch (err) {
    // Any initiation-phase failure leaves a CANCELLED order — never a
    // PENDING row that looks payable without a live checkout session.
    await prisma.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    if (err instanceof PaymentProviderError) {
      throw new AppError(
        502,
        "PAYMENT_PROVIDER_ERROR",
        "The payment provider could not complete the checkout — try again shortly",
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
      total: order.total.toString(),
      discountAmount: discountAmount.toFixed(2),
      discountId: discount?.id ?? null,
      status: "PENDING",
      delivery: checkoutDelivery,
    },
    payment: {
      provider: credential.provider,
      reference: paymentReference,
      redirectUrl: initiation.authorizationUrl,
    },
  };
}

/**
 * ============================================================
 * DASHBOARD ORDERS — list + detail (GET /api/dashboard/orders)
 * ============================================================
 * Read-only views over ALL of the store's orders — POS sales and
 * storefront checkouts, across every status (dashboard-orders.md).
 * Money values are decimal strings ("toFixed(2)"), never floats.
 */

export interface OrderSummary {
  id: string;
  orderNumber: string;
  status: $Enums.OrderStatus;
  paymentMethod: $Enums.PaymentMethod | null;
  source: $Enums.OrderSource;
  total: string;
  discountAmount: string;
  discountId: string | null;
  amountPaid: string | null;
  balanceDue: string;
  itemCount: number;
  customer: { id: string; name: string; phone: string | null; email: string | null };
  branch: { id: string; name: string };
  soldBy: { id: string; name: string } | null;
  /** Frozen fulfilment snapshot (storefront delivery); null for POS /
   * no-delivery orders. */
  delivery: {
    kind: $Enums.DeliveryKind;
    optionName: string;
    address: string | null;
    city: string | null;
    state: string | null;
    phone: string | null;
    instructions: string | null;
    fee: string;
  } | null;
  fulfillment: {
    status: $Enums.FulfillmentStatus;
    provider: string | null;
    courierName: string | null;
    courierPhone: string | null;
    shipmentReference: string | null;
    trackingUrl: string | null;
  };
  createdAt: Date;
}

export interface OrdersPage {
  items: OrderSummary[];
  nextCursor: string | null;
}

function balanceDueOf(
  paymentMethod: $Enums.PaymentMethod | null,
  total: Prisma.Decimal,
  amountPaid: Prisma.Decimal | null,
): string {
  if (paymentMethod === "CREDIT" && amountPaid !== null) {
    return total.sub(amountPaid).toFixed(2);
  }
  return "0.00";
}

/** Frozen fulfilment snapshot for an order row (null when no delivery). */
function deliverySnapshotOf(row: {
  deliveryKind: $Enums.DeliveryKind | null;
  deliveryOptionName: string | null;
  deliveryAddress: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryPhone: string | null;
  deliveryInstructions: string | null;
  deliveryFee: { toFixed: (n: number) => string };
}): OrderSummary["delivery"] {
  if (row.deliveryKind === null || row.deliveryOptionName === null) return null;
  return {
    kind: row.deliveryKind,
    optionName: row.deliveryOptionName,
    address: row.deliveryAddress,
    city: row.deliveryCity,
    state: row.deliveryState,
    phone: row.deliveryPhone,
    instructions: row.deliveryInstructions,
    fee: row.deliveryFee.toFixed(2),
  };
}

/**
 * Cursor-paginated, newest-first order list. `cursor` is the last order
 * id of the previous page: uuidv7 ids are time-ordered, so `id < cursor`
 * yields the next older page with a deterministic tie-break (id desc
 * when two orders share a millisecond).
 */
export async function listOrders(storeId: string, params: ListOrdersParams): Promise<OrdersPage> {
  const prisma = getPrismaClient();
  const where: Prisma.OrderWhereInput = { storeId };
  if (params.status !== undefined) where.status = params.status;
  if (params.paymentMethod !== undefined) where.paymentMethod = params.paymentMethod;
  if (params.source !== undefined) where.source = params.source;
  if (params.date !== undefined) {
    const start = new Date(`${params.date}T00:00:00.000Z`);
    where.createdAt = { gte: start, lt: new Date(start.getTime() + 86_400_000) };
  }
  if (params.cursor !== undefined) where.id = { lt: params.cursor };
  if (params.customerId !== undefined) where.customerId = params.customerId;
  if (params.q !== undefined) {
    where.customer = {
      OR: [
        { name: { contains: params.q, mode: "insensitive" } },
        { phone: { contains: params.q, mode: "insensitive" } },
      ],
    };
  }

  const rows = await prisma.order.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: params.limit,
    select: {
      id: true,
      orderNumber: true,
      status: true,
      fulfillmentStatus: true,
      deliveryProvider: true,
      courierName: true,
      courierPhone: true,
      shipmentReference: true,
      trackingUrl: true,
      paymentMethod: true,
      source: true,
      total: true,
      discountAmount: true,
      discountId: true,
      amountPaid: true,
      deliveryKind: true,
      deliveryOptionName: true,
      deliveryAddress: true,
      deliveryCity: true,
      deliveryState: true,
      deliveryPhone: true,
      deliveryInstructions: true,
      deliveryFee: true,
      createdAt: true,
      customer: { select: { id: true, name: true, phone: true, email: true } },
      branch: { select: { id: true, name: true } },
      soldByStaff: {
        select: { id: true, account: { select: { firstName: true, lastName: true, email: true } } },
      },
      _count: { select: { lineItems: true } },
    },
  });

  const items: OrderSummary[] = rows.map((row) => ({
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    paymentMethod: row.paymentMethod,
    source: row.source,
    total: row.total.toFixed(2),
    discountAmount: row.discountAmount.toFixed(2),
    discountId: row.discountId,
    amountPaid: row.amountPaid?.toFixed(2) ?? null,
    balanceDue: balanceDueOf(row.paymentMethod, row.total, row.amountPaid),
    itemCount: row._count.lineItems,
    customer: row.customer,
    branch: row.branch,
    soldBy:
      row.soldByStaff === null
        ? null
        : {
            id: row.soldByStaff.id,
            name:
              [row.soldByStaff.account.firstName, row.soldByStaff.account.lastName]
                .filter((part): part is string => part !== null && part !== undefined)
                .join(" ") || row.soldByStaff.account.email,
          },
    delivery: deliverySnapshotOf(row),
    fulfillment: {
      status: row.fulfillmentStatus,
      provider: row.deliveryProvider,
      courierName: row.courierName,
      courierPhone: row.courierPhone,
      shipmentReference: row.shipmentReference,
      trackingUrl: row.trackingUrl,
    },
    createdAt: row.createdAt,
  }));

  const nextCursor =
    rows.length === params.limit && rows.length > 0 ? rows[rows.length - 1]!.id : null;
  return { items, nextCursor };
}

export interface OrderDetail {
  order: OrderSummary;
  repayments: {
    id: string;
    amount: string;
    note: string | null;
    recordedByName: string | null;
    createdAt: Date;
  }[];
  lineItems: {
    id: string;
    productId: string;
    productName: string;
    variantId: string | null;
    variantName: string | null;
    quantity: number;
    unitPriceAtPurchase: string;
    lineTotal: string;
  }[];
}

/** One order with its captured line items (404 when not this store's). */
export async function getOrderDetail(storeId: string, orderId: string): Promise<OrderDetail> {
  const prisma = getPrismaClient();
  const row = await prisma.order.findFirst({
    where: { id: orderId, storeId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      fulfillmentStatus: true,
      deliveryProvider: true,
      courierName: true,
      courierPhone: true,
      shipmentReference: true,
      trackingUrl: true,
      paymentMethod: true,
      source: true,
      total: true,
      discountAmount: true,
      discountId: true,
      amountPaid: true,
      deliveryKind: true,
      deliveryOptionName: true,
      deliveryAddress: true,
      deliveryCity: true,
      deliveryState: true,
      deliveryPhone: true,
      deliveryInstructions: true,
      deliveryFee: true,
      createdAt: true,
      customer: { select: { id: true, name: true, phone: true, email: true } },
      branch: { select: { id: true, name: true } },
      soldByStaff: {
        select: { id: true, account: { select: { firstName: true, lastName: true, email: true } } },
      },
      lineItems: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          quantity: true,
          unitPriceAtPurchase: true,
          product: { select: { id: true, name: true } },
          variant: { select: { id: true, name: true } },
        },
      },
      creditRepayments: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          amount: true,
          note: true,
          recordedByStaff: {
            select: { account: { select: { firstName: true, lastName: true, email: true } } },
          },
          createdAt: true,
        },
      },
    },
  });
  if (row === null) {
    throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
  }

  return {
    order: {
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status,
      paymentMethod: row.paymentMethod,
      source: row.source,
      total: row.total.toFixed(2),
      discountAmount: row.discountAmount.toFixed(2),
      discountId: row.discountId,
      amountPaid: row.amountPaid?.toFixed(2) ?? null,
      balanceDue: balanceDueOf(row.paymentMethod, row.total, row.amountPaid),
      itemCount: row.lineItems.reduce((sum, line) => sum + line.quantity, 0),
      customer: row.customer,
      branch: row.branch,
      soldBy:
        row.soldByStaff === null
          ? null
          : {
              id: row.soldByStaff.id,
              name:
                [row.soldByStaff.account.firstName, row.soldByStaff.account.lastName]
                  .filter((part): part is string => part !== null && part !== undefined)
                  .join(" ") || row.soldByStaff.account.email,
            },
      delivery: deliverySnapshotOf(row),
      fulfillment: {
        status: row.fulfillmentStatus,
        provider: row.deliveryProvider,
        courierName: row.courierName,
        courierPhone: row.courierPhone,
        shipmentReference: row.shipmentReference,
        trackingUrl: row.trackingUrl,
      },
      createdAt: row.createdAt,
    },
    repayments: row.creditRepayments.map((repayment) => ({
      id: repayment.id,
      amount: repayment.amount.toFixed(2),
      note: repayment.note,
      recordedByName:
        repayment.recordedByStaff === null
          ? null
          : [
              repayment.recordedByStaff.account.firstName,
              repayment.recordedByStaff.account.lastName,
            ]
              .filter((part): part is string => part !== null && part !== undefined)
              .join(" ") || repayment.recordedByStaff.account.email,
      createdAt: repayment.createdAt,
    })),
    lineItems: row.lineItems.map((line) => ({
      id: line.id,
      productId: line.product.id,
      productName: line.product.name,
      variantId: line.variant?.id ?? null,
      variantName: line.variant?.name ?? null,
      quantity: line.quantity,
      unitPriceAtPurchase: line.unitPriceAtPurchase.toFixed(2),
      lineTotal: line.unitPriceAtPurchase.mul(line.quantity).toFixed(2),
    })),
  };
}

/**
 * ============================================================
 * PUBLIC ORDER STATUS (bank-transfer customer self-service)
 * ============================================================
 * Keyed by the order's public UUID (returned at checkout), never the
 * orderNumber. Reads the FROZEN bank-details snapshot — never the live
 * BankAccount row — so editing/deleting the merchant's bank account can't
 * misdirect an in-flight payment.
 */

export interface PublicOrderView {
  id: string;
  status: $Enums.OrderStatus;
  fulfillment: {
    status: $Enums.FulfillmentStatus;
    courierName: string | null;
    shipmentReference: string | null;
    trackingUrl: string | null;
    events: { status: $Enums.FulfillmentStatus; createdAt: Date }[];
  };
  paymentProvider: string | null;
  paymentReference: string | null;
  bankDetails: {
    bankName: string;
    accountName: string;
    accountNumber: string;
    reference: string | null;
  } | null;
  delivery: {
    kind: $Enums.DeliveryKind;
    optionName: string;
    address: string | null;
    city: string | null;
    state: string | null;
    phone: string | null;
    instructions: string | null;
    fee: string;
  } | null;
}

export async function getPublicOrder(orderId: string): Promise<PublicOrderView> {
  const prisma = getPrismaClient();
  const order = await prisma.order.findFirst({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      fulfillmentStatus: true,
      courierName: true,
      shipmentReference: true,
      trackingUrl: true,
      fulfillmentEvents: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { status: true, createdAt: true },
      },
      paymentProvider: true,
      paymentReference: true,
      bankName: true,
      accountName: true,
      accountNumber: true,
      deliveryKind: true,
      deliveryOptionName: true,
      deliveryAddress: true,
      deliveryCity: true,
      deliveryState: true,
      deliveryPhone: true,
      deliveryInstructions: true,
      deliveryFee: true,
    },
  });
  if (order === null) {
    throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
  }
  return {
    id: order.id,
    status: order.status,
    fulfillment: {
      status: order.fulfillmentStatus,
      courierName: order.courierName,
      shipmentReference: order.shipmentReference,
      trackingUrl: order.trackingUrl,
      events: order.fulfillmentEvents,
    },
    paymentProvider: order.paymentProvider,
    paymentReference: order.paymentReference,
    bankDetails:
      order.paymentProvider === "bank_transfer"
        ? {
            bankName: order.bankName ?? "",
            accountName: order.accountName ?? "",
            accountNumber: order.accountNumber ?? "",
            reference: order.paymentReference,
          }
        : null,
    delivery:
      order.deliveryKind !== null && order.deliveryOptionName !== null
        ? {
            kind: order.deliveryKind,
            optionName: order.deliveryOptionName,
            address: order.deliveryAddress,
            city: order.deliveryCity,
            state: order.deliveryState,
            phone: order.deliveryPhone,
            instructions: order.deliveryInstructions,
            fee: order.deliveryFee.toFixed(2),
          }
        : null,
  };
}

/**
 * Customer clicks "I have paid". Atomically moves PENDING→AWAITING_PAYMENT
 * and stamps paymentSubmittedAt, then fires the PAYMENT_CLAIMED alert.
 * Idempotent: a second click on an already-claimed order returns its current
 * state instead of erroring.
 */
export async function markBankTransferPaid(orderId: string): Promise<PublicOrderView> {
  const prisma = getPrismaClient();
  const order = await prisma.order.findFirst({
    where: { id: orderId },
    select: { id: true, storeId: true, status: true, paymentProvider: true },
  });
  if (order === null) {
    throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
  }
  if (order.paymentProvider !== "bank_transfer") {
    throw new AppError(409, "INVALID_PAYMENT_METHOD", "This order was not paid by bank transfer");
  }
  if (order.status === "AWAITING_PAYMENT") {
    return getPublicOrder(orderId);
  }
  if (order.status === "PAID") {
    throw new AppError(409, "ORDER_ALREADY_PAID", "Order has already been confirmed");
  }
  const updated = await prisma.order.updateMany({
    where: { id: orderId, status: "PENDING", paymentProvider: "bank_transfer" },
    data: { status: "AWAITING_PAYMENT", paymentSubmittedAt: new Date() },
  });
  if (updated.count === 0) {
    throw new AppError(409, "ORDER_NOT_PENDING", "Order is not awaiting payment");
  }
  await notifyPaymentClaimed(defaultAlertSender(), order.storeId, orderId);
  return getPublicOrder(orderId);
}

/**
 * ============================================================
 * DASHBOARD BANK-TRANSFER CONFIRM / REJECT (owner + orders.manage)
 * ============================================================
 */

/**
 * Merchant confirms a claimed bank-transfer payment. Validates the entered
 * amount against the order total, then atomically claims AWAITING_PAYMENT→PAID
 * and decrements stock (no wallet credit — that's the CARD flow). The atomic
 * claim is also the double-confirm and expiry-sweep race guard: if the sweep
 * already flipped the order back to PENDING, or another confirm landed first,
 * the claim matches 0 rows and we 409.
 */
export async function confirmBankTransferPayment(
  storeId: string,
  orderId: string,
  confirmedAmount: number | string | undefined,
): Promise<OrderDetail> {
  const prisma = getPrismaClient();
  const order = await prisma.order.findFirst({
    where: { id: orderId, storeId },
    select: { status: true, paymentProvider: true, total: true },
  });
  if (order === null) {
    throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
  }
  if (order.paymentProvider !== "bank_transfer") {
    throw new AppError(409, "INVALID_PAYMENT_METHOD", "This order was not paid by bank transfer");
  }
  if (order.status === "PAID") {
    throw new AppError(409, "ORDER_ALREADY_PAID", "Order has already been confirmed");
  }
  if (order.status !== "AWAITING_PAYMENT") {
    throw new AppError(
      409,
      "ORDER_NOT_AWAITING_PAYMENT",
      "Order is not awaiting payment confirmation",
    );
  }
  // Confirm the entered amount matches the order total exactly.
  const entered = new Prisma.Decimal(String(confirmedAmount ?? 0));
  if (!entered.equals(order.total)) {
    throw new AppError(422, "AMOUNT_MISMATCH", "The entered amount does not match the order total");
  }

  await prisma.$transaction(async (tx) => {
    const paid = await markOrderPaidAndDecrementStock(tx, orderId, storeId, {
      fromStatus: "AWAITING_PAYMENT",
      amountPaid: order.total,
    });
    if (!paid) {
      throw new AppError(409, "CONFIRM_CONFLICT", "Order was already confirmed or swept");
    }
  });

  // Manual confirmation: no wallet credit. Just alert the merchant.
  await notifyPaymentReceived(defaultAlertSender(), storeId, NOTIFICATION_REF_TYPES.ORDER, orderId);
  await sendCustomerReceiptWithDefault(storeId, NOTIFICATION_REF_TYPES.ORDER, orderId);

  return getOrderDetail(storeId, orderId);
}

/** Merchant rejects a claimed payment back to PENDING. */
export async function rejectBankTransferPayment(
  storeId: string,
  orderId: string,
): Promise<OrderDetail> {
  const prisma = getPrismaClient();
  const result = await prisma.order.updateMany({
    where: { id: orderId, storeId, status: "AWAITING_PAYMENT", paymentProvider: "bank_transfer" },
    data: { status: "PENDING", paymentSubmittedAt: null },
  });
  if (result.count === 0) {
    throw new AppError(
      409,
      "ORDER_NOT_AWAITING_PAYMENT",
      "Order is not awaiting payment confirmation",
    );
  }
  return getOrderDetail(storeId, orderId);
}

/**
 * Reclaims stale bank-transfer claims. An AWAITING_PAYMENT order whose "I have
 * paid" click (paymentSubmittedAt) is older than the configured max age is
 * flipped back to PENDING, so a merchant's queue can't fill with abandoned or
 * false claims.
 *
 * The WHERE clause keys on status: "AWAITING_PAYMENT" — the same guard
 * confirm-payment uses (`markOrderPaidAndDecrementStock`). Both are atomic
 * conditional UPDATEs on the same status, so a concurrent confirm and sweep
 * can never both apply: one flips it to PAID (or PENDING), the other's WHERE
 * then matches 0 rows and is a no-op. Exactly one transition, never partial.
 * Returns the number of reclaimed orders.
 */
export async function expireAwaitingPaymentOrders(now: Date = new Date()): Promise<number> {
  const prisma = getPrismaClient();
  const cutoff = new Date(now.getTime() - env.EXPIRY_SWEEP_MAX_AGE_MS);
  const result = await prisma.order.updateMany({
    where: {
      status: "AWAITING_PAYMENT",
      paymentSubmittedAt: { not: null, lt: cutoff },
    },
    data: { status: "PENDING", paymentSubmittedAt: null },
  });
  return result.count;
}

/**
 * In-process timer that runs the expiry sweep on an interval. No-op under
 * NODE_ENV=test (tests call expireAwaitingPaymentOrders directly). The timer
 * is unref'd so a server with no other work can exit cleanly. Mirrors
 * startAlertScheduler in notifications/service.ts.
 */
export function startExpirySweep(): void {
  if (process.env.NODE_ENV === "test") return;
  if (env.EXPIRY_SWEEP_INTERVAL_MS <= 0) return;

  const run = (): void => {
    expireAwaitingPaymentOrders().catch((err) => {
      console.error(
        `[orders] expiry sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
  run();
  const timer = setInterval(run, env.EXPIRY_SWEEP_INTERVAL_MS);
  timer.unref();
}
