import { createHash } from "node:crypto";
import type { CartEntry, CartContext } from "./service.js";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function cartFingerprint(
  quantities: Map<string, CartEntry>,
  context: CartContext,
  configuration: {
    categoryId: number;
    packageLengthCm: { toFixed(n: number): string };
    packageWidthCm: { toFixed(n: number): string };
    packageHeightCm: { toFixed(n: number): string };
  },
  priceOf: (entry: CartEntry, context: CartContext) => string,
): string {
  const lines = [...quantities.values()]
    .map((entry) => {
      const product = context.byId.get(entry.productId)!;
      return {
        productId: entry.productId,
        variantId: entry.variantId,
        quantity: entry.quantity,
        unitAmount: priceOf(entry, context),
        unitWeightKg: product.shippingWeightKg?.toFixed(3) ?? null,
      };
    })
    .sort((a, b) => `${a.productId}:${a.variantId ?? ""}`.localeCompare(`${b.productId}:${b.variantId ?? ""}`));
  return hash({
    lines,
    categoryId: configuration.categoryId,
    packageLengthCm: configuration.packageLengthCm.toFixed(2),
    packageWidthCm: configuration.packageWidthCm.toFixed(2),
    packageHeightCm: configuration.packageHeightCm.toFixed(2),
  });
}

export function destinationFingerprint(input: {
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  instructions?: string;
}): string {
  return hash({
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    phone: input.phone.trim(),
    address: input.address.trim(),
    city: input.city.trim(),
    state: input.state.trim(),
    instructions: input.instructions?.trim() ?? "",
  });
}

export function addressFingerprint(input: {
  name: string;
  email: string;
  phone: string;
  address: string;
}): string {
  return hash({
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    phone: input.phone.trim(),
    address: input.address.trim(),
  });
}
