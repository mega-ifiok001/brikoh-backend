const ORDER_NUMBER_WIDTH = 4;
function padNumber(value, width = ORDER_NUMBER_WIDTH) {
    return String(value).padStart(width, "0");
}
/**
 * Bumps the store's order counter atomically and returns the next
 * store-sequential order number (`ORD-####`). Must run inside the same
 * transaction that creates the order, so numbers are gap-free per store
 * and never reused. Same pattern as invoice (`INV-####`) and
 * purchase-order (`PO-####`) numbering.
 */
export async function nextOrderNumber(tx, storeId) {
    const store = await tx.store.update({
        where: { id: storeId },
        data: { orderCounter: { increment: 1 } },
        select: { orderCounter: true },
    });
    return `ORD-${padNumber(store.orderCounter)}`;
}
//# sourceMappingURL=numbering.js.map