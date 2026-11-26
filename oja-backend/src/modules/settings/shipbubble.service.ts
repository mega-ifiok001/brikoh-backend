import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { logStoreActivity } from "../activity/service.js";
import { ShipbubbleApiError, shipbubbleClient } from "../../lib/providers/shipbubble.js";
import { validateOrThrow, shipbubbleConfigSchema, type ShipbubbleConfigInput } from "./schemas.js";

export async function getShipbubbleConfig(storeId: string) {
  const row = await getPrismaClient().shipbubbleStoreConfig.findUnique({ where: { storeId } });
  if (row === null) return { configured: false } as const;
  return {
    configured: true,
    senderAddressCode: row.senderAddressCode,
    categoryId: row.categoryId,
    packageDimension: {
      length: row.packageLengthCm.toFixed(2),
      width: row.packageWidthCm.toFixed(2),
      height: row.packageHeightCm.toFixed(2),
    },
  } as const;
}

/** Validates the merchant pickup address with Shipbubble before saving its address code. */
export async function configureShipbubble(
  storeId: string,
  staffMemberId: string | undefined,
  rawInput: unknown,
) {
  const data = validateOrThrow(shipbubbleConfigSchema, rawInput) as ShipbubbleConfigInput;
  let address: { address_code: number; formatted_address?: string };
  try {
    address = await shipbubbleClient.validateAddress(data.sender);
  } catch (error) {
    if (error instanceof ShipbubbleApiError) {
      throw new AppError(502, "SHIPBUBBLE_ADDRESS_VALIDATION_FAILED", "Shipbubble could not validate the pickup address");
    }
    throw error;
  }
  if (!Number.isSafeInteger(address.address_code) || address.address_code <= 0) {
    throw new AppError(502, "SHIPBUBBLE_INVALID_RESPONSE", "Shipbubble returned an invalid address code");
  }

  const prisma = getPrismaClient();
  const saved = await prisma.$transaction(async (tx) => {
    const row = await tx.shipbubbleStoreConfig.upsert({
      where: { storeId },
      create: {
        storeId,
        senderAddressCode: address.address_code,
        categoryId: data.categoryId,
        packageLengthCm: data.packageDimension.length,
        packageWidthCm: data.packageDimension.width,
        packageHeightCm: data.packageDimension.height,
      },
      update: {
        senderAddressCode: address.address_code,
        categoryId: data.categoryId,
        packageLengthCm: data.packageDimension.length,
        packageWidthCm: data.packageDimension.width,
        packageHeightCm: data.packageDimension.height,
      },
    });
    await logStoreActivity(tx, {
      storeId,
      staffMemberId: staffMemberId ?? null,
      action: "settings.shipbubble.configured",
      detail: { senderAddressCode: address.address_code, categoryId: data.categoryId },
    });
    return row;
  });
  return {
    configured: true,
    senderAddressCode: saved.senderAddressCode,
    formattedAddress: address.formatted_address ?? null,
    categoryId: saved.categoryId,
    packageDimension: {
      length: saved.packageLengthCm.toFixed(2),
      width: saved.packageWidthCm.toFixed(2),
      height: saved.packageHeightCm.toFixed(2),
    },
  };
}
