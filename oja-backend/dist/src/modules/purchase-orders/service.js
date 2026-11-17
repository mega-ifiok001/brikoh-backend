import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import { recordPurchaseReceiptStockChanges } from "../products/ledger.service.js";
import { createPurchaseOrderSchema, listPurchaseOrdersParamsSchema, purchaseOrderPaymentSchema, receivePurchaseOrderSchema, updatePurchaseOrderSchema, } from "./schemas.js";
/**
 * ============================================================
 * PURCHASE ORDERS SERVICE — goods ordered from a supplier
 * ============================================================
 * Lifecycle: DRAFT (editable, deletable) -> ORDERED (locked; number +
 * orderedAt stamped) -> PARTIALLY_RECEIVED / RECEIVED (receipt-driven)
 * or CANCELLED (from DRAFT/ORDERED only, with no receipts).
 *
 * RECEIVING is the only way stock enters a PO: each receipt writes an
 * append-only PurchaseOrderReceipt (with lines), advances the line's
 * quantityReceived, and records RESTOCK movements through the stock
 * ledger (referenceId = the order id) — all in one transaction, so the
 * receipt ledger, the line state, and the stock numbers commit or roll
 * back together.
 *
 * Payments settle through an append-only PurchaseOrderPayment ledger
 * (InvoicePayment pattern): amountPaid advances per row and can never
 * exceed the outstanding balance. There is no PAID status — payment
 * and receiving are independent.
 * ============================================================
 */
const NUMBER_WIDTH = 4;
function padNumber(value) {
    return String(value).padStart(NUMBER_WIDTH, "0");
}
function recordedName(account) {
    if (account === null)
        return null;
    return ([account.firstName, account.lastName]
        .filter((part) => part !== null && part !== undefined)
        .join(" ") || account.email);
}
function totalOf(lineItems) {
    return lineItems.reduce((sum, line) => sum.add(new Prisma.Decimal(line.unitCostAtOrder).mul(line.quantity)), new Prisma.Decimal(0));
}
async function purchaseOrderRow(storeId, purchaseOrderId) {
    const prisma = getPrismaClient();
    const row = await prisma.purchaseOrder.findFirst({
        where: { id: purchaseOrderId, storeId },
        select: {
            id: true,
            number: true,
            status: true,
            total: true,
            amountPaid: true,
            notes: true,
            expectedDeliveryDate: true,
            createdAt: true,
            orderedAt: true,
            receivedAt: true,
            cancelledAt: true,
            supplier: { select: { id: true, name: true } },
            branch: { select: { id: true, name: true } },
            receipts: {
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                select: {
                    id: true,
                    note: true,
                    recordedByStaff: {
                        select: { account: { select: { firstName: true, lastName: true, email: true } } },
                    },
                    createdAt: true,
                    lines: {
                        orderBy: { createdAt: "asc" },
                        select: {
                            productId: true,
                            variantId: true,
                            quantityReceived: true,
                            unitCostAtReceipt: true,
                            product: { select: { name: true } },
                            variant: { select: { name: true } },
                        },
                    },
                },
            },
            payments: {
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                select: {
                    id: true,
                    amount: true,
                    note: true,
                    recordedByStaff: {
                        select: { account: { select: { firstName: true, lastName: true, email: true } } },
                    },
                    createdAt: true,
                },
            },
            lineItems: {
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    quantity: true,
                    quantityReceived: true,
                    unitCostAtOrder: true,
                    productId: true,
                    variantId: true,
                    product: { select: { name: true } },
                    variant: { select: { name: true } },
                },
            },
        },
    });
    if (row === null) {
        throw new AppError(404, "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found");
    }
    return row;
}
/** One order with its captured line items, receipt timeline, and payment timeline. */
export async function getPurchaseOrderDetail(storeId, purchaseOrderId) {
    const row = await purchaseOrderRow(storeId, purchaseOrderId);
    return {
        purchaseOrder: {
            id: row.id,
            number: row.number,
            status: row.status,
            total: row.total.toFixed(2),
            amountPaid: row.amountPaid.toFixed(2),
            balanceDue: row.total.sub(row.amountPaid).toFixed(2),
            notes: row.notes,
            expectedDeliveryDate: row.expectedDeliveryDate,
            supplier: row.supplier,
            branch: row.branch,
            createdAt: row.createdAt,
            orderedAt: row.orderedAt,
            receivedAt: row.receivedAt,
            cancelledAt: row.cancelledAt,
        },
        lineItems: row.lineItems.map((line) => ({
            id: line.id,
            productId: line.productId,
            productName: line.product.name,
            variantId: line.variantId,
            variantName: line.variant?.name ?? null,
            quantity: line.quantity,
            quantityReceived: line.quantityReceived,
            remainingToReceive: line.quantity - line.quantityReceived,
            unitCostAtOrder: line.unitCostAtOrder.toFixed(2),
            lineTotal: line.unitCostAtOrder.mul(line.quantity).toFixed(2),
        })),
        receipts: row.receipts.map((receipt) => ({
            id: receipt.id,
            note: receipt.note,
            recordedByName: recordedName(receipt.recordedByStaff?.account ?? null),
            createdAt: receipt.createdAt,
            lines: receipt.lines.map((line) => ({
                productId: line.productId,
                productName: line.product.name,
                variantId: line.variantId,
                variantName: line.variant?.name ?? null,
                quantityReceived: line.quantityReceived,
                unitCostAtReceipt: line.unitCostAtReceipt.toFixed(2),
            })),
        })),
        payments: row.payments.map((payment) => ({
            id: payment.id,
            amount: payment.amount.toFixed(2),
            note: payment.note,
            recordedByName: recordedName(payment.recordedByStaff?.account ?? null),
            createdAt: payment.createdAt,
        })),
    };
}
/**
 * Verifies every line item's product (and named variant) belongs to
 * the store, applying the stock-ledger variant rules: a product WITH
 * variants must be ordered per variant (VARIANT_REQUIRED), a named
 * variant must belong to its product (VARIANT_NOT_FOUND), and a
 * variant-less product must not name one. Soft-deleted products are
 * PRODUCT_NOT_FOUND, same as the ledger's classification.
 */
async function assertLinesInStore(tx, storeId, lineItems) {
    for (const line of lineItems) {
        const product = await tx.product.findFirst({
            where: { id: line.productId, storeId, deletedAt: null },
            select: { id: true },
        });
        if (product === null) {
            throw new AppError(404, "PRODUCT_NOT_FOUND", "A line item names a product outside this store");
        }
        if (line.variantId !== undefined) {
            const variant = await tx.productVariant.findFirst({
                // Archived (retired) variants cannot be re-ordered.
                where: { id: line.variantId, storeId, productId: line.productId, archivedAt: null },
                select: { id: true },
            });
            if (variant === null) {
                throw new AppError(404, "VARIANT_NOT_FOUND", "Variant not found");
            }
        }
        else {
            const variantCount = await tx.productVariant.count({ where: { productId: line.productId } });
            if (variantCount > 0) {
                throw new AppError(400, "VARIANT_REQUIRED", "This product has variants — order it per variant");
            }
        }
    }
}
/** Creates a DRAFT order with its line items (costs captured here). */
export async function createPurchaseOrder(storeId, staffMemberId, rawInput) {
    const data = validateOrThrow(createPurchaseOrderSchema, rawInput);
    const prisma = getPrismaClient();
    const created = await prisma.$transaction(async (tx) => {
        const supplier = await tx.supplier.findFirst({
            where: { id: data.supplierId, storeId },
            select: { id: true },
        });
        if (supplier === null) {
            throw new AppError(404, "SUPPLIER_NOT_FOUND", "Supplier not found");
        }
        const branch = await tx.branch.findFirst({
            where: { id: data.branchId, storeId },
            select: { id: true },
        });
        if (branch === null) {
            throw new AppError(404, "BRANCH_NOT_FOUND", "Branch not found");
        }
        await assertLinesInStore(tx, storeId, data.lineItems);
        const purchaseOrder = await tx.purchaseOrder.create({
            data: {
                storeId,
                supplierId: data.supplierId,
                branchId: data.branchId,
                total: totalOf(data.lineItems),
                expectedDeliveryDate: data.expectedDeliveryDate ?? null,
                notes: data.notes ?? null,
                createdByStaffId: staffMemberId ?? null,
                lineItems: {
                    create: data.lineItems.map((line) => ({
                        storeId,
                        productId: line.productId,
                        variantId: line.variantId ?? null,
                        quantity: line.quantity,
                        unitCostAtOrder: new Prisma.Decimal(line.unitCostAtOrder),
                    })),
                },
            },
            select: { id: true },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "purchaseOrder.created",
            detail: { purchaseOrderId: purchaseOrder.id },
        });
        return purchaseOrder;
    });
    return getPurchaseOrderDetail(storeId, created.id);
}
/** Replaces the line items of a DRAFT order and recomputes the total. */
export async function updatePurchaseOrder(storeId, staffMemberId, purchaseOrderId, rawInput) {
    const data = validateOrThrow(updatePurchaseOrderSchema, rawInput);
    const prisma = getPrismaClient();
    const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.purchaseOrder.findFirst({
            where: { id: purchaseOrderId, storeId },
            select: { id: true, status: true },
        });
        if (row === null) {
            throw new AppError(404, "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found");
        }
        if (row.status !== "DRAFT") {
            throw new AppError(409, "ORDER_NOT_EDITABLE", "Only DRAFT purchase orders can be edited");
        }
        const supplier = await tx.supplier.findFirst({
            where: { id: data.supplierId, storeId },
            select: { id: true },
        });
        if (supplier === null) {
            throw new AppError(404, "SUPPLIER_NOT_FOUND", "Supplier not found");
        }
        const branch = await tx.branch.findFirst({
            where: { id: data.branchId, storeId },
            select: { id: true },
        });
        if (branch === null) {
            throw new AppError(404, "BRANCH_NOT_FOUND", "Branch not found");
        }
        await assertLinesInStore(tx, storeId, data.lineItems);
        const purchaseOrder = await tx.purchaseOrder.update({
            where: { id: row.id },
            data: {
                supplierId: data.supplierId,
                branchId: data.branchId,
                total: totalOf(data.lineItems),
                expectedDeliveryDate: data.expectedDeliveryDate,
                notes: data.notes,
                lineItems: {
                    deleteMany: {},
                    create: data.lineItems.map((line) => ({
                        storeId,
                        productId: line.productId,
                        variantId: line.variantId ?? null,
                        quantity: line.quantity,
                        unitCostAtOrder: new Prisma.Decimal(line.unitCostAtOrder),
                    })),
                },
            },
            select: { id: true },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "purchaseOrder.updated",
            detail: { purchaseOrderId: purchaseOrder.id },
        });
        return purchaseOrder;
    });
    return getPurchaseOrderDetail(storeId, updated.id);
}
/** Permanently deletes a DRAFT order (cascades its line items). */
export async function deletePurchaseOrder(storeId, staffMemberId, purchaseOrderId) {
    const prisma = getPrismaClient();
    await prisma.$transaction(async (tx) => {
        const row = await tx.purchaseOrder.findFirst({
            where: { id: purchaseOrderId, storeId },
            select: { id: true, status: true },
        });
        if (row === null) {
            throw new AppError(404, "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found");
        }
        if (row.status !== "DRAFT") {
            throw new AppError(409, "ORDER_NOT_EDITABLE", "Only DRAFT purchase orders can be deleted");
        }
        await tx.purchaseOrder.delete({ where: { id: row.id } });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "purchaseOrder.deleted",
            detail: { purchaseOrderId },
        });
    });
}
/**
 * Transitions DRAFT -> ORDERED: stamps orderedAt and assigns the next
 * store-sequential PO-#### number. The counter is bumped atomically
 * inside the same transaction, so concurrent issues never collide.
 */
export async function issuePurchaseOrder(storeId, staffMemberId, purchaseOrderId) {
    const prisma = getPrismaClient();
    const issued = await prisma.$transaction(async (tx) => {
        const row = await tx.purchaseOrder.findFirst({
            where: { id: purchaseOrderId, storeId },
            select: { id: true, status: true },
        });
        if (row === null) {
            throw new AppError(404, "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found");
        }
        if (row.status !== "DRAFT") {
            throw new AppError(409, "ORDER_NOT_EDITABLE", "Only DRAFT purchase orders can be issued");
        }
        const store = await tx.store.update({
            where: { id: storeId },
            data: { purchaseOrderCounter: { increment: 1 } },
            select: { purchaseOrderCounter: true },
        });
        const purchaseOrder = await tx.purchaseOrder.update({
            where: { id: row.id },
            data: {
                status: "ORDERED",
                number: `PO-${padNumber(store.purchaseOrderCounter)}`,
                orderedAt: new Date(),
            },
            select: { id: true },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "purchaseOrder.issued",
            detail: {
                purchaseOrderId: purchaseOrder.id,
                number: `PO-${padNumber(store.purchaseOrderCounter)}`,
            },
        });
        return purchaseOrder;
    });
    return getPurchaseOrderDetail(storeId, issued.id);
}
/**
 * Transitions DRAFT/ORDERED -> CANCELLED. Only with no receipts — an
 * order that started arriving cannot be cancelled (its ledger rows and
 * stock movements are the record). Cancelled orders are terminal.
 */
export async function cancelPurchaseOrder(storeId, staffMemberId, purchaseOrderId) {
    const prisma = getPrismaClient();
    const cancelled = await prisma.$transaction(async (tx) => {
        const row = await tx.purchaseOrder.findFirst({
            where: { id: purchaseOrderId, storeId },
            select: { id: true, status: true },
        });
        if (row === null) {
            throw new AppError(404, "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found");
        }
        if (row.status !== "DRAFT" && row.status !== "ORDERED") {
            throw new AppError(409, "ORDER_NOT_CANCELLABLE", "Only DRAFT or ORDERED purchase orders can be cancelled");
        }
        const receiptCount = await tx.purchaseOrderReceipt.count({
            where: { purchaseOrderId: row.id },
        });
        if (receiptCount > 0) {
            throw new AppError(409, "ORDER_NOT_CANCELLABLE", "An order with receipts cannot be cancelled");
        }
        const purchaseOrder = await tx.purchaseOrder.update({
            where: { id: row.id },
            data: { status: "CANCELLED", cancelledAt: new Date() },
            select: { id: true },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "purchaseOrder.cancelled",
            detail: { purchaseOrderId: purchaseOrder.id },
        });
        return purchaseOrder;
    });
    return getPurchaseOrderDetail(storeId, cancelled.id);
}
/**
 * Records a partial or full delivery against an ORDERED /
 * PARTIALLY_RECEIVED order, in the order's branch. ONE transaction
 * writes the append-only receipt (header + lines), advances the line
 * quantities, records the RESTOCK stock-ledger movements (referenceId
 * = the order id), recomputes the status (all lines in -> RECEIVED with
 * receivedAt; any line outstanding -> PARTIALLY_RECEIVED), and logs
 * the activity entry. unitCostAtReceipt is copied from the order line.
 */
export async function receivePurchaseOrder(storeId, staffMemberId, purchaseOrderId, rawInput) {
    const data = validateOrThrow(receivePurchaseOrderSchema, rawInput);
    const prisma = getPrismaClient();
    const received = await prisma.$transaction(async (tx) => {
        const row = await tx.purchaseOrder.findFirst({
            where: { id: purchaseOrderId, storeId },
            select: { id: true, status: true, branchId: true },
        });
        if (row === null) {
            throw new AppError(404, "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found");
        }
        if (row.status !== "ORDERED" && row.status !== "PARTIALLY_RECEIVED") {
            throw new AppError(409, "ORDER_NOT_RECEIVABLE", "Only ORDERED or PARTIALLY_RECEIVED purchase orders can receive stock");
        }
        const lines = await tx.purchaseOrderLineItem.findMany({
            where: { purchaseOrderId: row.id },
            select: {
                id: true,
                productId: true,
                variantId: true,
                quantity: true,
                quantityReceived: true,
                unitCostAtOrder: true,
            },
        });
        const lineMap = new Map(lines.map((line) => [line.id, line]));
        for (const item of data.lineItems) {
            const line = lineMap.get(item.lineItemId);
            if (line === undefined) {
                throw new AppError(404, "LINE_ITEM_NOT_FOUND", "A line item does not belong to this purchase order");
            }
            if (item.quantityReceived > line.quantity - line.quantityReceived) {
                throw new AppError(400, "VALIDATION_ERROR", "quantityReceived exceeds the line's outstanding quantity");
            }
        }
        const receipt = await tx.purchaseOrderReceipt.create({
            data: {
                storeId,
                purchaseOrderId: row.id,
                branchId: row.branchId,
                note: data.note ?? null,
                recordedByStaffId: staffMemberId ?? null,
                lines: {
                    create: data.lineItems.map((item) => {
                        const line = lineMap.get(item.lineItemId);
                        return {
                            storeId,
                            purchaseOrderId: row.id,
                            productId: line.productId,
                            variantId: line.variantId,
                            quantityReceived: item.quantityReceived,
                            unitCostAtReceipt: line.unitCostAtOrder,
                        };
                    }),
                },
            },
            select: { id: true },
        });
        const movements = data.lineItems.map((item) => {
            const line = lineMap.get(item.lineItemId);
            return {
                storeId,
                branchId: row.branchId,
                productId: line.productId,
                variantId: line.variantId ?? undefined,
                quantityChange: item.quantityReceived,
                performedByStaffId: staffMemberId,
                referenceId: row.id,
            };
        });
        await recordPurchaseReceiptStockChanges(tx, movements);
        for (const item of data.lineItems) {
            await tx.purchaseOrderLineItem.update({
                where: { id: item.lineItemId },
                data: { quantityReceived: { increment: item.quantityReceived } },
            });
        }
        const allIn = lines.every((line) => line.quantityReceived +
            (data.lineItems.find((item) => item.lineItemId === line.id)?.quantityReceived ?? 0) >=
            line.quantity);
        const purchaseOrder = await tx.purchaseOrder.update({
            where: { id: row.id },
            data: allIn
                ? { status: "RECEIVED", receivedAt: new Date() }
                : { status: "PARTIALLY_RECEIVED" },
            select: { id: true },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "purchaseOrder.received",
            detail: {
                purchaseOrderId: purchaseOrder.id,
                receiptId: receipt.id,
                lines: data.lineItems.length,
            },
        });
        return purchaseOrder;
    });
    return getPurchaseOrderDetail(storeId, received.id);
}
/**
 * Records a payment to the supplier. The append-only ledger row is
 * written with the amountPaid advance in one transaction; a payment can
 * never exceed the outstanding balance.
 */
export async function recordPurchaseOrderPayment(storeId, staffMemberId, purchaseOrderId, rawInput) {
    const data = validateOrThrow(purchaseOrderPaymentSchema, rawInput);
    const prisma = getPrismaClient();
    const result = await prisma.$transaction(async (tx) => {
        const row = await tx.purchaseOrder.findFirst({
            where: { id: purchaseOrderId, storeId },
            select: { id: true, status: true, total: true, amountPaid: true },
        });
        if (row === null) {
            throw new AppError(404, "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found");
        }
        if (row.status === "DRAFT" || row.status === "CANCELLED") {
            throw new AppError(409, "ORDER_NOT_PAYABLE", "Only live purchase orders are payable");
        }
        const amount = new Prisma.Decimal(data.amount);
        const balanceDue = row.total.sub(row.amountPaid);
        if (amount.gt(balanceDue)) {
            throw new AppError(400, "PAYMENT_EXCEEDS_BALANCE", `Payment exceeds the outstanding balance of ${balanceDue.toFixed(2)}`);
        }
        await tx.purchaseOrderPayment.create({
            data: {
                storeId,
                purchaseOrderId: row.id,
                amount,
                note: data.note ?? null,
                recordedByStaffId: staffMemberId ?? null,
            },
        });
        await tx.purchaseOrder.update({
            where: { id: row.id },
            data: { amountPaid: { increment: amount } },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "purchaseOrder.payment.recorded",
            detail: { purchaseOrderId: row.id, amount: amount.toFixed(2) },
        });
        return { amount, allocated: amount, balanceDue: balanceDue.sub(amount) };
    });
    return {
        amount: result.amount.toFixed(2),
        allocated: result.allocated.toFixed(2),
        balanceDue: result.balanceDue.toFixed(2),
    };
}
/** Lists orders, newest first, with cursor pagination like invoices. */
export async function listPurchaseOrders(storeId, rawParams) {
    const params = validateOrThrow(listPurchaseOrdersParamsSchema, rawParams);
    const prisma = getPrismaClient();
    const rows = await prisma.purchaseOrder.findMany({
        where: {
            storeId,
            ...(params.status !== undefined ? { status: params.status } : {}),
            ...(params.supplierId !== undefined ? { supplierId: params.supplierId } : {}),
            ...(params.cursor !== undefined ? { id: { lt: params.cursor } } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: params.limit + 1,
        select: {
            id: true,
            number: true,
            status: true,
            total: true,
            amountPaid: true,
            expectedDeliveryDate: true,
            createdAt: true,
            orderedAt: true,
            supplier: { select: { id: true, name: true } },
            branch: { select: { id: true, name: true } },
            _count: { select: { lineItems: true } },
        },
    });
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    return {
        items: page.map((row) => ({
            id: row.id,
            number: row.number,
            status: row.status,
            total: row.total.toFixed(2),
            amountPaid: row.amountPaid.toFixed(2),
            balanceDue: row.total.sub(row.amountPaid).toFixed(2),
            expectedDeliveryDate: row.expectedDeliveryDate,
            itemCount: row._count.lineItems,
            supplier: row.supplier,
            branch: row.branch,
            createdAt: row.createdAt,
            orderedAt: row.orderedAt,
        })),
        nextCursor: hasMore ? page[page.length - 1].id : null,
    };
}
//# sourceMappingURL=service.js.map