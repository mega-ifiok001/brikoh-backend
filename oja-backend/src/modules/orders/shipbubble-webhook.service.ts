import { createHash } from "node:crypto";
import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";

interface ShipbubbleWebhookPayload {
  order_id: string;
  status: string;
  date?: string;
  courier?: { name?: string; phone?: string; tracking_code?: string } | null;
  tracking_url?: string | null;
  waybill_document?: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapProviderStatus(status: string): "READY_FOR_DISPATCH" | "DISPATCHED" | "DELIVERED" | "CANCELLED" | null {
  switch (status.toLowerCase()) {
    case "pending":
    case "confirmed":
      return "READY_FOR_DISPATCH";
    case "picked_up":
    case "in_transit":
      return "DISPATCHED";
    case "completed":
      return "DELIVERED";
    case "cancelled":
      return "CANCELLED";
    default:
      return null;
  }
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export async function processShipbubbleWebhook(raw: unknown): Promise<{ accepted: true; duplicate: boolean }> {
  if (!isObject(raw) || typeof raw.order_id !== "string" || typeof raw.status !== "string") {
    throw new AppError(400, "INVALID_SHIPBUBBLE_WEBHOOK", "Webhook is missing shipment ID or status");
  }
  const payload = raw as unknown as ShipbubbleWebhookPayload;
  const nextStatus = mapProviderStatus(payload.status);
  if (nextStatus === null) return { accepted: true, duplicate: true };

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      order_id: payload.order_id,
      status: payload.status,
      date: payload.date ?? "",
      tracking_code: payload.courier?.tracking_code ?? "",
    }))
    .digest("hex");

  const prisma = getPrismaClient();
  const shipment = await prisma.shipbubbleShipment.findUnique({
    where: { providerOrderId: payload.order_id },
    select: {
      id: true,
      storeId: true,
      orderId: true,
      bookingState: true,
      lastWebhookFingerprint: true,
      order: { select: { fulfillmentStatus: true, status: true } },
    },
  });
  if (shipment === null || shipment.bookingState !== "BOOKED") {
    throw new AppError(404, "SHIPBUBBLE_SHIPMENT_NOT_FOUND", "Shipment is not registered with Brikoh");
  }
  if (shipment.lastWebhookFingerprint === fingerprint) return { accepted: true, duplicate: true };

  const current = shipment.order.fulfillmentStatus;
  const orderProgress = ["ORDER_RECEIVED", "CONFIRMED", "PREPARING", "READY_FOR_DISPATCH", "DISPATCHED", "DELIVERED"];
  const targetProgress = ["READY_FOR_DISPATCH", "DISPATCHED", "DELIVERED"].indexOf(nextStatus);
  const currentProgress = orderProgress.indexOf(current);
  // Ignore stale callbacks that would move a shipment backward. Terminal
  // cancellation/failure states are handled independently below.
  if (nextStatus !== "CANCELLED" && targetProgress >= 0 && currentProgress > targetProgress) {
    await prisma.shipbubbleShipment.update({
      where: { id: shipment.id },
      data: { lastWebhookFingerprint: fingerprint },
    });
    return { accepted: true, duplicate: true };
  }

  const courier = isObject(payload.courier) ? payload.courier : {};
  const trackingUrl = safeHttpsUrl(payload.tracking_url);
  const waybillUrl = safeHttpsUrl(payload.waybill_document);
  const eventKey = `shipbubble:${fingerprint}`;

  await prisma.$transaction(async (tx) => {
    const prior = await tx.orderFulfillmentEvent.findUnique({ where: { idempotencyKey: eventKey } });
    if (prior !== null) {
      await tx.shipbubbleShipment.update({
        where: { id: shipment.id },
        data: { lastWebhookFingerprint: fingerprint },
      });
      return;
    }

    if (nextStatus !== current) {
      const changed = await tx.order.updateMany({
        where: { id: shipment.orderId, storeId: shipment.storeId, status: "PAID", fulfillmentStatus: current },
        data: {
          fulfillmentStatus: nextStatus,
          ...(typeof courier.name === "string" ? { courierName: courier.name.slice(0, 200) } : {}),
          ...(typeof courier.phone === "string" ? { courierPhone: courier.phone.slice(0, 30) } : {}),
          ...(typeof courier.tracking_code === "string" ? { shipmentReference: courier.tracking_code.slice(0, 200) } : {}),
          ...(trackingUrl !== null ? { trackingUrl } : {}),
        },
      });
      if (changed.count !== 1) {
        throw new AppError(409, "SHIPBUBBLE_ORDER_CHANGED", "Order changed while processing shipment status");
      }
      await tx.orderFulfillmentEvent.create({
        data: {
          orderId: shipment.orderId,
          status: nextStatus,
          source: "SHIPBUBBLE",
          note: `Shipbubble status: ${payload.status}`.slice(0, 500),
          courierName: typeof courier.name === "string" ? courier.name.slice(0, 200) : null,
          shipmentReference: typeof courier.tracking_code === "string" ? courier.tracking_code.slice(0, 200) : payload.order_id,
          idempotencyKey: eventKey,
        },
      });
    }

    await tx.shipbubbleShipment.update({
      where: { id: shipment.id },
      data: {
        providerStatus: payload.status.slice(0, 80),
        lastWebhookFingerprint: fingerprint,
        ...(trackingUrl !== null ? { trackingUrl } : {}),
        ...(waybillUrl !== null ? { waybillUrl } : {}),
        providerResponse: raw as unknown as Prisma.InputJsonValue,
        ...(nextStatus === "CANCELLED" ? { bookingState: "CANCELLED" } : {}),
      },
    });
  });

  return { accepted: true, duplicate: false };
}
