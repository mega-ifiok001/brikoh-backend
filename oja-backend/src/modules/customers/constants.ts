import { Prisma } from "../../../generated/prisma/client.js";

/**
 * Customer segmentation (analytics enrichment). Computed LIVE on every
 * read — nothing is persisted, so a customer's segment always reflects
 * the current ledger:
 *
 *   NEW     — zero orders ever
 *   VIP     — lifetime spend of at least VIP_SPEND_THRESHOLD across
 *             successful sales (PAID/SHIPPED only)
 *   REGULAR — anything in between
 */

/** Lifetime spend that promotes a customer to VIP (naira-equivalent). */
export const VIP_SPEND_THRESHOLD = new Prisma.Decimal(1_000_000);

export type CustomerSegment = "NEW" | "REGULAR" | "VIP";

export function computeCustomerSegment(
  ordersCount: number,
  totalSpent: Prisma.Decimal,
): CustomerSegment {
  if (ordersCount === 0) {
    return "NEW";
  }
  return totalSpent.gte(VIP_SPEND_THRESHOLD) ? "VIP" : "REGULAR";
}
