import type { $Enums } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { updateFulfillmentSchema, type UpdateFulfillmentInput } from "./schemas.js";

type FulfillmentStatus = $Enums.FulfillmentStatus;

const transitions: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  ORDER_RECEIVED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY_FOR_DISPATCH", "READY_FOR_PICKUP", "CANCELLED"],
  READY_FOR_DISPATCH: ["DISPATCHED", "DELIVERY_FAILED", "CANCELLED"],
  DISPATCHED: ["DELIVERED", "DELIVERY_FAILED"],
  DELIVERED: [],
  DELIVERY_FAILED: ["READY_FOR_DISPATCH", "CANCELLED"],
  READY_FOR_PICKUP: ["COLLECTED", "CANCELLED"],
  COLLECTED: [],
  CANCELLED: [],
};

function assertKindStatus(kind: $Enums.DeliveryKind | null, status: FulfillmentStatus): void {
  if (kind === "PICKUP" && ["READY_FOR_DISPATCH", "DISPATCHED", "DELIVERED", "DELIVERY_FAILED"].includes(status)) {
    throw new AppError(409, "FULFILLMENT_STATUS_INVALID", "Delivery-only status cannot be used for pickup orders");
  }
  if (kind === "DELIVERY" && ["READY_FOR_PICKUP", "COLLECTED"].includes(status)) {
    throw new AppError(409, "FULFILLMENT_STATUS_INVALID", "Pickup-only status cannot be used for delivery orders");
  }
  if (kind === null) {
    throw new AppError(409, "FULFILLMENT_NOT_CONFIGURED", "This order has no delivery or pickup option");
  }
}

export interface FulfillmentView {
  status: FulfillmentStatus;
  provider: string | null;
  courierName: string | null;
  courierPhone: string | null;
  shipmentReference: string | null;
  trackingUrl: string | null;
  events: {
    id: string;
    status: FulfillmentStatus;
    source: $Enums.FulfillmentEventSource;
    note: string | null;
    courierName: string | null;
    shipmentReference: string | null;
    createdAt: Date;
  }[];
}

export async function getFulfillment(storeId: string, orderId: string): Promise<FulfillmentView> {
  const order = await getPrismaClient().order.findFirst({
    where: { id: orderId, storeId },
    select: {
      fulfillmentStatus: true,
      deliveryProvider: true,
      courierName: true,
      courierPhone: true,
      shipmentReference: true,
      trackingUrl: true,
      fulfillmentEvents: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          status: true,
          source: true,
          note: true,
          courierName: true,
          shipmentReference: true,
          createdAt: true,
        },
      },
    },
  });
  if (order === null) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
  return {
    status: order.fulfillmentStatus,
    provider: order.deliveryProvider,
    courierName: order.courierName,
    courierPhone: order.courierPhone,
    shipmentReference: order.shipmentReference,
    trackingUrl: order.trackingUrl,
    events: order.fulfillmentEvents,
  };
}

export async function updateFulfillment(
  storeId: string,
  orderId: string,
  staffMemberId: string | undefined,
  rawInput: unknown,
  idempotencyKey: string | undefined,
): Promise<FulfillmentView> {
  const data = validateOrThrow(updateFulfillmentSchema, rawInput) as UpdateFulfillmentInput;
  const prisma = getPrismaClient();
  const order = await prisma.order.findFirst({
    where: { id: orderId, storeId },
    select: {
      id: true,
      status: true,
      fulfillmentStatus: true,
      deliveryKind: true,
      deliveryProvider: true,
      courierName: true,
      courierPhone: true,
      shipmentReference: true,
      trackingUrl: true,
    },
  });
  if (order === null) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
  if (order.status !== "PAID") {
    throw new AppError(409, "ORDER_NOT_PAID", "Confirm payment before arranging fulfilment");
  }
  assertKindStatus(order.deliveryKind, data.status);

  if (data.status !== order.fulfillmentStatus && !transitions[order.fulfillmentStatus].includes(data.status)) {
    throw new AppError(
      409,
      "FULFILLMENT_TRANSITION_INVALID",
      `Cannot move fulfilment from ${order.fulfillmentStatus} to ${data.status}`,
    );
  }

  // Merchant-managed orders may record any rider/courier. Provider booking
  // fields are populated only by the server-side provider integration.
  if (order.deliveryProvider === "shipbubble" && data.status !== order.fulfillmentStatus) {
    throw new AppError(409, "PROVIDER_MANAGED_FULFILLMENT", "Shipbubble shipment updates are provider-managed");
  }

  if (idempotencyKey !== undefined && (idempotencyKey.length < 8 || idempotencyKey.length > 200)) {
    throw new AppError(400, "VALIDATION_ERROR", "Idempotency-Key must contain 8 to 200 characters");
  }

  await prisma.$transaction(async (tx) => {
    if (idempotencyKey !== undefined) {
      const prior = await tx.orderFulfillmentEvent.findUnique({ where: { idempotencyKey } });
      if (prior !== null) {
        if (prior.orderId !== order.id) {
          throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was used for another order");
        }
        return;
      }
    }

    if (data.status !== order.fulfillmentStatus) {
      const changed = await tx.order.updateMany({
        where: { id: order.id, storeId, fulfillmentStatus: order.fulfillmentStatus, status: "PAID" },
        data: {
          fulfillmentStatus: data.status,
          deliveryProvider: order.deliveryProvider ?? "manual",
          ...(data.courierName !== undefined ? { courierName: data.courierName } : {}),
          ...(data.courierPhone !== undefined ? { courierPhone: data.courierPhone } : {}),
          ...(data.shipmentReference !== undefined ? { shipmentReference: data.shipmentReference } : {}),
          ...(data.trackingUrl !== undefined ? { trackingUrl: data.trackingUrl } : {}),
        },
      });
      if (changed.count !== 1) {
        throw new AppError(409, "FULFILLMENT_CHANGED", "Order fulfilment changed; reload and try again");
      }
      await tx.orderFulfillmentEvent.create({
        data: {
          orderId: order.id,
          status: data.status,
          source: "MERCHANT",
          note: data.note ?? null,
          actorStaffId: staffMemberId ?? null,
          courierName: data.courierName ?? order.courierName,
          shipmentReference: data.shipmentReference ?? order.shipmentReference,
          idempotencyKey: idempotencyKey ?? null,
        },
      });
    } else if (
      data.courierName !== undefined ||
      data.courierPhone !== undefined ||
      data.shipmentReference !== undefined ||
      data.trackingUrl !== undefined
    ) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          ...(data.courierName !== undefined ? { courierName: data.courierName } : {}),
          ...(data.courierPhone !== undefined ? { courierPhone: data.courierPhone } : {}),
          ...(data.shipmentReference !== undefined ? { shipmentReference: data.shipmentReference } : {}),
          ...(data.trackingUrl !== undefined ? { trackingUrl: data.trackingUrl } : {}),
        },
      });
    }
  });

  return getFulfillment(storeId, orderId);
}
