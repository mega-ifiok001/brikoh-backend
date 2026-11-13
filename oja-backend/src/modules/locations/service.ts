import type { Location } from "../../../generated/prisma/client.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { enforceLocationCap } from "../subscriptions/service.js";
import { createLocationSchema, type CreateLocationInput } from "./schemas.js";

type LocationRow = Location;

/**
 * Creates a location in the tenant's storefront set. The tenant is always
 * the caller-supplied storeId from req.tenant — never client input.
 *
 * Enforces the subscription's locationCap (409 LOCATION_LIMIT_REACHED) when
 * the store has a subscription with a non-null cap; no subscription (or a
 * null cap) = unlimited. Nothing is persisted at/over the cap.
 */
export async function createLocation(storeId: string, input: unknown): Promise<LocationRow> {
  const data = validateOrThrow(createLocationSchema, input) as CreateLocationInput;
  await enforceLocationCap(storeId);
  return getPrismaClient().location.create({
    data: { storeId, name: data.name, address: data.address ?? null },
  });
}

/**
 * Lists the tenant's locations, oldest first. Tenant-scoped: never returns
 * another store's locations.
 */
export async function listLocations(storeId: string): Promise<LocationRow[]> {
  return getPrismaClient().location.findMany({
    where: { storeId },
    orderBy: { createdAt: "asc" },
  });
}
