import type { Prisma } from "../../../generated/prisma/client.js";

const ORDER_NUMBER_WIDTH = 4;

function padNumber(value: number, width = ORDER_NUMBER_WIDTH): string {
  return String(value).padStart(width, "0");
}

/**
 * Bumps the store's order counter atomically and returns the next
 * store-sequential order number (`ORD-####`). Must run inside the same
 * transaction that creates the order, so numbers are gap-free per store
 * and never reused. Same pattern as invoice (`INV-####`) and
 * purchase-order (`PO-####`) numbering.
 */
export async function nextOrderNumber(
  tx: Pick<Prisma.TransactionClient, "store">,
  storeId: string,
): Promise<string> {
  const store = await tx.store.update({
    where: { id: storeId },
    data: { orderCounter: { increment: 1 } },
    select: { orderCounter: true },
  });
  return `ORD-${padNumber(store.orderCounter)}`;
}
