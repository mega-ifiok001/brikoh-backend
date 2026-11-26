import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { ShipbubbleApiError, shipbubbleClient } from "../../lib/providers/shipbubble.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { assertCartAvailable, aggregateCartItems, effectiveUnitPrice, loadCartContext } from "./service.js";
import { destinationFingerprint, cartFingerprint, addressFingerprint } from "./shipbubble-fingerprint.js";
import { shipbubbleRatesSchema, type ShipbubbleRatesInput } from "./schemas.js";
import { validateOrThrow } from "../../lib/validate.js";
import type { CartContext, CartEntry } from "./service.js";

const QUOTE_TTL_MS = 15 * 60_000;

function localPickupDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function toFiniteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

async function receiverAddressCode(
  storeId: string,
  input: ShipbubbleRatesInput,
): Promise<number> {
  const contact = {
    name: input.customer.name,
    email: input.customer.email,
    phone: input.deliveryPhone,
    address: `${input.deliveryAddress}, ${input.deliveryCity}, ${input.deliveryState}, Nigeria`,
  };
  const fingerprint = addressFingerprint(contact);
  const prisma = getPrismaClient();
  const cached = await prisma.shipbubbleAddressCache.findUnique({
    where: { storeId_fingerprint: { storeId, fingerprint } },
    select: { addressCode: true },
  });
  if (cached !== null) return cached.addressCode;

  let validated: { address_code: number; formatted_address?: string };
  try {
    validated = await shipbubbleClient.validateAddress(contact);
  } catch (error) {
    if (error instanceof ShipbubbleApiError) {
      throw new AppError(422, "DELIVERY_ADDRESS_UNSUPPORTED", "Shipbubble could not validate this delivery address; choose manual delivery or pickup");
    }
    throw error;
  }
  if (!Number.isSafeInteger(validated.address_code) || validated.address_code <= 0) {
    throw new AppError(502, "SHIPBUBBLE_INVALID_RESPONSE", "Shipbubble returned an invalid address code");
  }
  const saved = await prisma.shipbubbleAddressCache.upsert({
    where: { storeId_fingerprint: { storeId, fingerprint } },
    create: {
      storeId,
      fingerprint,
      addressCode: validated.address_code,
      formattedAddress: validated.formatted_address ?? null,
    },
    update: {},
    select: { addressCode: true },
  });
  return saved.addressCode;
}

export async function createShipbubbleRates(storeId: string, rawInput: unknown) {
  const input = validateOrThrow(shipbubbleRatesSchema, rawInput) as ShipbubbleRatesInput;
  const prisma = getPrismaClient();
  const [config, option, store] = await Promise.all([
    prisma.shipbubbleStoreConfig.findUnique({ where: { storeId } }),
    prisma.deliveryOption.findFirst({
      where: { id: input.deliveryOptionId, storeId, isActive: true, kind: "DELIVERY", provider: "SHIPBUBBLE" },
      select: { id: true, name: true },
    }),
    prisma.store.findUnique({ where: { id: storeId }, select: { defaultBranchId: true } }),
  ]);
  if (config === null) throw new AppError(409, "SHIPBUBBLE_NOT_CONFIGURED", "This store has not configured Shipbubble pickup and package details");
  if (option === null) throw new AppError(404, "DELIVERY_OPTION_NOT_FOUND", "Shipbubble delivery option is unavailable");
  if (store?.defaultBranchId === null || store === null) throw new AppError(409, "STORE_NOT_CONFIGURED", "This store has no default branch");

  const quantities = aggregateCartItems(input.items);
  const context = await loadCartContext(storeId, store.defaultBranchId, quantities);
  assertCartAvailable(quantities, context);
  const missingWeights = [...quantities.values()].filter((line) => context.byId.get(line.productId)?.shippingWeightKg == null);
  if (missingWeights.length > 0) {
    throw new AppError(409, "SHIPPING_WEIGHT_REQUIRED", "Add a shipping weight to every cart product before using Shipbubble");
  }

  const receiverCode = await receiverAddressCode(storeId, input);
  const packageItems = [...quantities.values()].map((line) => {
    const product = context.byId.get(line.productId)!;
    return {
      name: product.name,
      description: (product.description ?? product.name).slice(0, 500),
      unit_weight: product.shippingWeightKg!.toFixed(3),
      unit_amount: effectiveUnitPrice(line, context).toFixed(2),
      quantity: String(line.quantity),
    };
  });
  let rateData: Record<string, unknown>;
  try {
    rateData = await shipbubbleClient.fetchRates({
      sender_address_code: config.senderAddressCode,
      reciever_address_code: receiverCode,
      pickup_date: localPickupDate(),
      category_id: config.categoryId,
      package_items: packageItems,
      package_dimension: {
        length: Number(config.packageLengthCm),
        width: Number(config.packageWidthCm),
        height: Number(config.packageHeightCm),
      },
      ...(input.deliveryInstructions ? { delivery_instructions: input.deliveryInstructions } : {}),
    });
  } catch (error) {
    if (error instanceof ShipbubbleApiError) {
      throw new AppError(502, "SHIPBUBBLE_RATES_FAILED", "Shipbubble could not return delivery options for this route");
    }
    throw error;
  }

  const requestToken = rateData.request_token;
  const rawCouriers = rateData.couriers;
  if (typeof requestToken !== "string" || !Array.isArray(rawCouriers)) {
    throw new AppError(502, "SHIPBUBBLE_INVALID_RESPONSE", "Shipbubble returned an incomplete rates response");
  }
  const courierOptions = rawCouriers.flatMap((raw) => {
    if (raw === null || typeof raw !== "object") return [];
    const courier = raw as Record<string, unknown>;
    const fee = toFiniteNumber(courier.rate_card_amount ?? courier.total);
    const courierId = courier.courier_id;
    if (fee === null || fee < 0 || courierId === undefined || courier.service_code === undefined) return [];
    return [{
      courierId: String(courierId),
      serviceCode: String(courier.service_code),
      name: String(courier.courier_name ?? courier.service_code),
      fee: fee.toFixed(2),
      providerFee: (toFiniteNumber(courier.total) ?? fee).toFixed(2),
      currency: String(courier.rate_card_currency ?? courier.currency ?? "NGN"),
      serviceType: typeof courier.service_type === "string" ? courier.service_type : null,
      deliveryEta: typeof courier.delivery_eta === "string" ? courier.delivery_eta : null,
      deliveryEtaTime: typeof courier.delivery_eta_time === "string" ? courier.delivery_eta_time : null,
      trackingLevel: toFiniteNumber(courier.tracking_level),
      imageUrl: typeof courier.courier_image === "string" ? courier.courier_image : null,
    }];
  });
  if (courierOptions.length === 0) {
    throw new AppError(422, "SHIPBUBBLE_NO_RATES", "Shipbubble has no available courier for this route; choose manual delivery or pickup");
  }

  const [cartHash, destinationHash] = [
    cartFingerprint(quantities, context, config, (line, ctx) => effectiveUnitPrice(line, ctx).toFixed(2)),
    destinationFingerprint({
      name: input.customer.name,
      email: input.customer.email,
      phone: input.deliveryPhone,
      address: input.deliveryAddress,
      city: input.deliveryCity,
      state: input.deliveryState,
      instructions: input.deliveryInstructions,
    }),
  ];
  const quote = await prisma.shipbubbleRateQuote.create({
    data: {
      storeId,
      deliveryOptionId: option.id,
      requestToken,
      cartFingerprint: cartHash,
      destinationFingerprint: destinationHash,
      courierRates: rawCouriers as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + QUOTE_TTL_MS),
    },
    select: { id: true, expiresAt: true },
  });
  return { quoteId: quote.id, expiresAt: quote.expiresAt, options: courierOptions };
}

export interface SelectedShipbubbleRate {
  quoteId: string;
  requestToken: string;
  courierId: string;
  serviceCode: string;
  courierName: string;
  customerFee: string;
  providerFee: string;
  currency: string;
}

type ShipbubbleQuoteConfig = {
  categoryId: number;
  packageLengthCm: Prisma.Decimal;
  packageWidthCm: Prisma.Decimal;
  packageHeightCm: Prisma.Decimal;
};

export async function verifyShipbubbleCheckoutQuote(input: {
  storeId: string;
  optionId: string;
  quoteId: string;
  courierId: string;
  serviceCode: string;
  quantities: Map<string, CartEntry>;
  context: CartContext;
  config: ShipbubbleQuoteConfig;
  destination: { name: string; email: string; phone: string; address: string; city: string; state: string; instructions?: string };
}): Promise<SelectedShipbubbleRate> {
  const { storeId, optionId, quoteId, courierId, serviceCode, quantities, context, config, destination } = input;
  const quote = await getPrismaClient().shipbubbleRateQuote.findFirst({
    where: {
      id: quoteId,
      storeId,
      deliveryOptionId: optionId,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, requestToken: true, cartFingerprint: true, destinationFingerprint: true, courierRates: true },
  });
  if (quote === null) throw new AppError(409, "SHIPBUBBLE_QUOTE_EXPIRED", "Delivery rates expired; request updated rates");
  const currentCartHash = cartFingerprint(quantities, context, config, (line, ctx) => effectiveUnitPrice(line, ctx).toFixed(2));
  const currentDestinationHash = destinationFingerprint(destination);
  if (quote.cartFingerprint !== currentCartHash || quote.destinationFingerprint !== currentDestinationHash) {
    throw new AppError(409, "SHIPBUBBLE_QUOTE_MISMATCH", "Cart or delivery details changed; request updated rates");
  }
  if (!Array.isArray(quote.courierRates)) throw new AppError(502, "SHIPBUBBLE_INVALID_RESPONSE", "Stored delivery quote is invalid");
  const selected = quote.courierRates.find((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const rate = item as Record<string, unknown>;
    return String(rate.courier_id) === courierId && String(rate.service_code) === serviceCode;
  });
  if (selected === undefined || selected === null || typeof selected !== "object" || Array.isArray(selected)) {
    throw new AppError(409, "SHIPBUBBLE_RATE_NOT_FOUND", "Selected courier is not in the current quote");
  }
  const rate = selected as Record<string, unknown>;
  const fee = toFiniteNumber(rate.rate_card_amount ?? rate.total);
  const providerFee = toFiniteNumber(rate.total);
  if (fee === null || fee < 0) throw new AppError(502, "SHIPBUBBLE_INVALID_RESPONSE", "Selected courier rate has no valid fee");
  return {
    quoteId: quote.id,
    requestToken: quote.requestToken,
    courierId,
    serviceCode,
    courierName: String(rate.courier_name ?? rate.service_code),
    customerFee: fee.toFixed(2),
    providerFee: (providerFee ?? fee).toFixed(2),
    currency: String(rate.rate_card_currency ?? rate.currency ?? "NGN"),
  };
}

function providerDataNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function bookShipbubbleShipment(storeId: string, orderId: string) {
  shipbubbleClient.assertConfigured();
  const prisma = getPrismaClient();
  const order = await prisma.order.findFirst({
    where: { id: orderId, storeId },
    select: {
      id: true,
      status: true,
      deliveryKind: true,
      deliveryProvider: true,
      fulfillmentStatus: true,
      deliveryFee: true,
      courierName: true,
      shipbubbleCourierId: true,
      shipbubbleServiceCode: true,
      shipbubbleRateQuote: { select: { requestToken: true } },
      shipbubbleShipment: true,
    },
  });
  if (order === null) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
  if (order.shipbubbleShipment?.bookingState === "BOOKED") {
    return {
      providerOrderId: order.shipbubbleShipment.providerOrderId,
      courierName: order.shipbubbleShipment.courierName,
      trackingUrl: order.shipbubbleShipment.trackingUrl,
      bookingState: order.shipbubbleShipment.bookingState,
    };
  }
  if (order.status !== "PAID") throw new AppError(409, "ORDER_NOT_PAID", "Confirm payment before booking delivery");
  if (order.deliveryProvider !== "shipbubble" || order.deliveryKind !== "DELIVERY") {
    throw new AppError(409, "SHIPBUBBLE_NOT_SELECTED", "This order does not use Shipbubble delivery");
  }
  if (order.fulfillmentStatus !== "PREPARING") {
    throw new AppError(409, "ORDER_NOT_READY_FOR_BOOKING", "Confirm and prepare the order before booking delivery");
  }
  if (
    order.shipbubbleRateQuote === null ||
    order.shipbubbleCourierId === null ||
    order.shipbubbleServiceCode === null ||
    order.courierName === null
  ) {
    throw new AppError(409, "SHIPBUBBLE_QUOTE_MISSING", "The order has no selected Shipbubble quote");
  }

  let booking = order.shipbubbleShipment;
  if (booking?.bookingState === "BOOKED") return booking;
  if (booking?.bookingState === "CREATING" || booking?.bookingState === "UNKNOWN") {
    throw new AppError(409, "SHIPBUBBLE_BOOKING_PENDING", "A booking attempt is already in progress or needs reconciliation");
  }
  if (booking === null) {
    try {
      booking = await prisma.shipbubbleShipment.create({
        data: {
          storeId,
          orderId,
          requestToken: order.shipbubbleRateQuote.requestToken,
          courierId: order.shipbubbleCourierId,
          serviceCode: order.shipbubbleServiceCode,
          courierName: order.courierName,
          customerFee: order.deliveryFee,
          bookingState: "CREATING",
        },
      });
    } catch (error) {
      const existing = await prisma.shipbubbleShipment.findUnique({ where: { orderId } });
      if (existing !== null) throw new AppError(409, "SHIPBUBBLE_BOOKING_PENDING", "A booking attempt is already in progress");
      throw error;
    }
  } else {
    booking = await prisma.shipbubbleShipment.update({
      where: { id: booking.id },
      data: { bookingState: "CREATING", providerResponse: Prisma.JsonNull },
    });
  }

  let providerResponse: Record<string, unknown>;
  try {
    providerResponse = await shipbubbleClient.createLabel({
      request_token: booking.requestToken,
      service_code: booking.serviceCode,
      courier_id: booking.courierId,
    });
  } catch (error) {
    if (error instanceof ShipbubbleApiError) {
      await prisma.shipbubbleShipment.update({
        where: { id: booking.id },
        data: { bookingState: "FAILED" },
      });
      throw new AppError(502, "SHIPBUBBLE_BOOKING_FAILED", "Shipbubble could not book this shipment; no shipment was created");
    }
    await prisma.shipbubbleShipment.update({
      where: { id: booking.id },
      data: { bookingState: "UNKNOWN" },
    });
    throw error;
  }

  const providerOrderId = providerResponse.order_id;
  if (typeof providerOrderId !== "string" || providerOrderId.length === 0) {
    await prisma.shipbubbleShipment.update({
      where: { id: booking.id },
      data: { bookingState: "UNKNOWN", providerResponse: providerResponse as Prisma.InputJsonValue },
    });
    throw new AppError(502, "SHIPBUBBLE_INVALID_RESPONSE", "Shipment response did not include a provider reference");
  }
  const courier = providerResponse.courier !== null && typeof providerResponse.courier === "object"
    ? providerResponse.courier as Record<string, unknown>
    : {};
  const payment = providerResponse.payment !== null && typeof providerResponse.payment === "object"
    ? providerResponse.payment as Record<string, unknown>
    : {};
  const trackingUrl = safeShipbubbleUrl(providerResponse.tracking_url);
  const providerFee = providerDataNumber(payment.shipping_fee);
  const trackingCode = typeof courier.tracking_code === "string" ? courier.tracking_code : null;
  const courierName = typeof courier.name === "string" ? courier.name : order.courierName;

  const saved = await prisma.$transaction(async (tx) => {
    const changed = await tx.order.updateMany({
      where: { id: order.id, storeId, status: "PAID", fulfillmentStatus: "PREPARING", deliveryProvider: "shipbubble" },
      data: {
        fulfillmentStatus: "READY_FOR_DISPATCH",
        courierName: courierName.slice(0, 200),
        ...(typeof courier.phone === "string" ? { courierPhone: courier.phone.slice(0, 30) } : {}),
        shipmentReference: (trackingCode ?? providerOrderId).slice(0, 200),
        ...(trackingUrl !== null ? { trackingUrl } : {}),
      },
    });
    if (changed.count !== 1) throw new AppError(409, "ORDER_CHANGED", "Order changed during shipment booking; reconcile the provider shipment");
    await tx.orderFulfillmentEvent.create({
      data: {
        orderId,
        status: "READY_FOR_DISPATCH",
        source: "SHIPBUBBLE",
        courierName: courierName.slice(0, 200),
        shipmentReference: (trackingCode ?? providerOrderId).slice(0, 200),
        idempotencyKey: `shipbubble:booked:${providerOrderId}`,
      },
    });
    return tx.shipbubbleShipment.update({
      where: { id: booking!.id },
      data: {
        bookingState: "BOOKED",
        providerOrderId,
        providerStatus: typeof providerResponse.status === "string" ? providerResponse.status : "pending",
        courierName: courierName.slice(0, 200),
        ...(providerFee === null ? {} : { providerFee }),
        ...(typeof payment.currency === "string" ? { currency: payment.currency.slice(0, 8) } : {}),
        ...(trackingUrl !== null ? { trackingUrl } : {}),
        providerResponse: providerResponse as Prisma.InputJsonValue,
      },
    });
  });
  return saved;
}

function safeShipbubbleUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function cancelShipbubbleShipment(storeId: string, orderId: string) {
  shipbubbleClient.assertConfigured();
  const prisma = getPrismaClient();
  const shipment = await prisma.shipbubbleShipment.findFirst({
    where: { orderId, storeId },
    select: { id: true, providerOrderId: true, bookingState: true },
  });
  if (shipment === null || shipment.providerOrderId === null || shipment.bookingState !== "BOOKED") {
    throw new AppError(404, "SHIPBUBBLE_SHIPMENT_NOT_FOUND", "No active Shipbubble shipment exists for this order");
  }
  const orderState = await prisma.order.findFirst({
    where: { id: orderId, storeId },
    select: { status: true, fulfillmentStatus: true },
  });
  if (orderState?.status !== "PAID" || orderState.fulfillmentStatus !== "READY_FOR_DISPATCH") {
    throw new AppError(409, "SHIPBUBBLE_CANCELLATION_UNAVAILABLE", "Only a paid shipment that has not yet been dispatched can be cancelled");
  }
  let response: Record<string, unknown>;
  try {
    response = await shipbubbleClient.cancelLabel(shipment.providerOrderId);
  } catch (error) {
    if (error instanceof ShipbubbleApiError) {
      throw new AppError(409, "SHIPBUBBLE_CANCELLATION_FAILED", "Shipbubble could not cancel this shipment; it may already be in transit");
    }
    throw error;
  }
  const fingerprint = `shipbubble:cancel:${shipment.providerOrderId}`;
  await prisma.$transaction(async (tx) => {
    const changed = await tx.order.updateMany({
      where: { id: orderId, storeId, status: "PAID", fulfillmentStatus: "READY_FOR_DISPATCH" },
      data: { fulfillmentStatus: "CANCELLED" },
    });
    if (changed.count !== 1) throw new AppError(409, "SHIPBUBBLE_CANCELLATION_UNAVAILABLE", "Order changed while cancelling shipment");
    {
      await tx.orderFulfillmentEvent.create({
        data: {
          orderId,
          status: "CANCELLED",
          source: "SHIPBUBBLE",
          note: "Shipbubble shipment cancelled",
          idempotencyKey: fingerprint,
        },
      });
    }
    await tx.shipbubbleShipment.update({
      where: { id: shipment.id },
      data: { bookingState: "CANCELLED", providerStatus: "cancelled", providerResponse: response as Prisma.InputJsonValue },
    });
  });
  return { cancelled: true, refundIssued: false };
}
