import type { $Enums, Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import {
  deliveryOptionCreateSchema,
  deliveryOptionUpdateSchema,
  type DeliveryOptionCreateInput,
  type DeliveryOptionUpdateInput,
} from "./schemas.js";

/**
 * ============================================================
 * DELIVERY OPTIONS — the fulfilment choices at storefront checkout
 * ============================================================
 * A store's options ("Pick up at store", "Delivery Rider — ₦2,000"). The
 * buyer picks one at checkout and pays its `baseFee`; the fee is read from
 * this row, never from the client. Owner-only (the settings group).
 * Deleting an option is safe — orders freeze their own delivery snapshot,
 * so history never depends on this row. Phase 1 is flat-fee only.
 * ============================================================
 */

export interface DeliveryOptionView {
  id: string;
  name: string;
  kind: $Enums.DeliveryKind;
  provider: $Enums.DeliveryProvider;
  description: string | null;
  baseFee: string;
  isActive: boolean;
  sortOrder: number;
  pickupLocationId: string | null;
  pickupLocation: { id: string; name: string; address: string | null } | null;
  pickupAddressText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const optionInclude = {
  pickupLocation: { select: { id: true, name: true, address: true } },
} satisfies Prisma.DeliveryOptionInclude;

type OptionRow = {
  id: string;
  name: string;
  kind: $Enums.DeliveryKind;
  provider: $Enums.DeliveryProvider;
  description: string | null;
  baseFee: { toFixed: (n: number) => string };
  isActive: boolean;
  sortOrder: number;
  pickupLocationId: string | null;
  pickupLocation: { id: string; name: string; address: string | null } | null;
  pickupAddressText: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toView(row: OptionRow): DeliveryOptionView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    provider: row.provider,
    description: row.description,
    baseFee: row.baseFee.toFixed(2),
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    pickupLocationId: row.pickupLocationId,
    pickupLocation: row.pickupLocation,
    pickupAddressText: row.pickupAddressText,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listDeliveryOptions(storeId: string): Promise<DeliveryOptionView[]> {
  const rows = await getPrismaClient().deliveryOption.findMany({
    where: { storeId },
    include: optionInclude,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  return (rows as unknown as OptionRow[]).map(toView);
}

/** Validates a pickupLocationId belongs to the store (404 otherwise). */
async function assertPickupLocation(
  storeId: string,
  pickupLocationId: string | null | undefined,
): Promise<void> {
  if (pickupLocationId === null || pickupLocationId === undefined) return;
  const location = await getPrismaClient().location.findFirst({
    where: { id: pickupLocationId, storeId },
    select: { id: true },
  });
  if (location === null) {
    throw new AppError(404, "NOT_FOUND", "Pickup location not found");
  }
}

export async function createDeliveryOption(
  storeId: string,
  input: unknown,
  staffMemberId?: string,
): Promise<DeliveryOptionView> {
  const data = validateOrThrow(deliveryOptionCreateSchema, input) as DeliveryOptionCreateInput;
  if (data.provider === "SHIPBUBBLE" && data.kind !== "DELIVERY") {
    throw new AppError(400, "VALIDATION_ERROR", "Shipbubble can only be used for DELIVERY options");
  }
  const prisma = getPrismaClient();

  const clash = await prisma.deliveryOption.findFirst({
    where: { storeId, name: data.name },
    select: { id: true },
  });
  if (clash !== null) {
    throw new AppError(
      409,
      "DELIVERY_OPTION_EXISTS",
      "You already have a delivery option with that name",
    );
  }
  await assertPickupLocation(storeId, data.pickupLocationId);

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.deliveryOption.create({
      data: {
        storeId,
        name: data.name,
        kind: data.kind,
        provider: data.provider ?? "MANUAL",
        description: data.description ?? null,
        baseFee: data.provider === "SHIPBUBBLE" ? "0.00" : (data.baseFee ?? "0.00"),
        isActive: data.isActive ?? true,
        sortOrder: data.sortOrder ?? 0,
        pickupLocationId: data.pickupLocationId ?? null,
        pickupAddressText: data.pickupAddressText ?? null,
      },
      include: optionInclude,
    });
    await logStoreActivity(tx, {
      storeId,
      staffMemberId: staffMemberId ?? null,
      action: "settings.deliveryOption.created",
      detail: { deliveryOptionId: row.id, name: row.name, kind: row.kind },
    });
    return row;
  });

  return toView(created as unknown as OptionRow);
}

export async function updateDeliveryOption(
  storeId: string,
  optionId: string,
  input: unknown,
  staffMemberId?: string,
): Promise<DeliveryOptionView> {
  const data = validateOrThrow(deliveryOptionUpdateSchema, input) as DeliveryOptionUpdateInput;
  const prisma = getPrismaClient();

  const existing = await prisma.deliveryOption.findFirst({
    where: { id: optionId, storeId },
    select: { id: true, kind: true, provider: true },
  });
  if (existing === null) {
    throw new AppError(404, "NOT_FOUND", "Delivery option not found");
  }
  const nextKind = data.kind ?? existing.kind;
  const nextProvider = data.provider ?? existing.provider;
  if (nextProvider === "SHIPBUBBLE" && nextKind !== "DELIVERY") {
    throw new AppError(400, "VALIDATION_ERROR", "Shipbubble can only be used for DELIVERY options");
  }
  if (data.name !== undefined) {
    const clash = await prisma.deliveryOption.findFirst({
      where: { storeId, name: data.name, id: { not: optionId } },
      select: { id: true },
    });
    if (clash !== null) {
      throw new AppError(
        409,
        "DELIVERY_OPTION_EXISTS",
        "You already have a delivery option with that name",
      );
    }
  }
  await assertPickupLocation(storeId, data.pickupLocationId);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.deliveryOption.update({
      where: { id: optionId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.kind !== undefined ? { kind: data.kind } : {}),
        ...(data.provider !== undefined ? { provider: data.provider } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.baseFee !== undefined || data.provider === "SHIPBUBBLE"
          ? { baseFee: nextProvider === "SHIPBUBBLE" ? "0.00" : data.baseFee }
          : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
        ...(data.pickupLocationId !== undefined
          ? { pickupLocationId: data.pickupLocationId }
          : {}),
        ...(data.pickupAddressText !== undefined
          ? { pickupAddressText: data.pickupAddressText }
          : {}),
      },
      include: optionInclude,
    });
    await logStoreActivity(tx, {
      storeId,
      staffMemberId: staffMemberId ?? null,
      action: "settings.deliveryOption.updated",
      detail: { deliveryOptionId: optionId, updatedFields: Object.keys(data) },
    });
    return row;
  });

  return toView(updated as unknown as OptionRow);
}

export async function deleteDeliveryOption(
  storeId: string,
  optionId: string,
  staffMemberId?: string,
): Promise<void> {
  const prisma = getPrismaClient();
  const existing = await prisma.deliveryOption.findFirst({
    where: { id: optionId, storeId },
    select: { id: true },
  });
  if (existing === null) {
    throw new AppError(404, "NOT_FOUND", "Delivery option not found");
  }
  await prisma.$transaction(async (tx) => {
    await tx.deliveryOption.delete({ where: { id: optionId } });
    await logStoreActivity(tx, {
      storeId,
      staffMemberId: staffMemberId ?? null,
      action: "settings.deliveryOption.deleted",
      detail: { deliveryOptionId: optionId },
    });
  });
}
