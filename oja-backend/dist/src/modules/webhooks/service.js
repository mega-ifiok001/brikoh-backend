import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { createPaystackProvider } from "../../lib/providers/paystack.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { decryptSecret } from "../../lib/secrets.js";
import { recordSaleStockChanges } from "../products/ledger.service.js";
import { defaultAlertSender } from "../notifications/email.js";
import { notifyPaymentReceived, NOTIFICATION_REF_TYPES } from "../notifications/service.js";
import { sendCustomerReceiptWithDefault } from "../receipts/service.js";
import { creditWallet } from "../wallet/service.js";
import { paystackWebhookSchema, validateOrThrow } from "./schemas.js";
const PROVIDER_KEY = "paystack";
const HANDLED_EVENTS = new Set([
    "charge.success",
    "charge.failed",
    "transfer.success",
    "transfer.failed",
]);
const defaultProviderFactory = ({ publicKey, secretKey }) => createPaystackProvider({ publicKey, secretKey });
function isUniqueViolation(err) {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
export async function handlePaystackWebhook(rawBody, signature, providerFactory = defaultProviderFactory) {
    let payload;
    try {
        payload = validateOrThrow(paystackWebhookSchema, JSON.parse(rawBody.toString("utf8")));
    }
    catch (err) {
        if (err instanceof SyntaxError) {
            throw new AppError(400, "VALIDATION_ERROR", "Malformed JSON body");
        }
        throw err;
    }
    // Unknown event types are acknowledged and ignored — before any
    // verification or write, so arbitrary provider events never fail
    // (Paystack would otherwise redeliver forever).
    if (!HANDLED_EVENTS.has(payload.event)) {
        return { outcome: "IGNORED" };
    }
    const prisma = getPrismaClient();
    // 1. Dedup gate — the unique constraint is the real authority; the
    //    find is just the cheap pre-check (the insert race is caught by
    //    P2002 inside the transaction).
    const existing = await prisma.webhookEvent.findUnique({
        where: {
            provider_externalEventId: {
                provider: PROVIDER_KEY,
                externalEventId: payload.data.id,
            },
        },
    });
    if (existing !== null) {
        return { outcome: "DUPLICATE" };
    }
    // 2. Source resolution. charge.* events resolve the ORDER from the
    //    echoed payment reference; transfer.* events resolve the PAYOUT
    //    from the transfer code (or the wd_… reference). The store is
    //    always derived from the resolved row, never from the payload.
    let storeId;
    let orderId = null;
    let orderStatus = null;
    let payoutId = null;
    if (payload.event.startsWith("transfer.")) {
        const payout = await resolvePayout(payload.data.transfer_code, payload.data.reference);
        storeId = payout.storeId;
        payoutId = payout.id;
    }
    else {
        const order = await prisma.order.findFirst({
            where: { paymentReference: payload.data.reference },
            select: { id: true, storeId: true, status: true },
        });
        if (order === null) {
            throw new AppError(404, "ORDER_NOT_FOUND", "No order matches this payment reference");
        }
        storeId = order.storeId;
        orderId = order.id;
        orderStatus = order.status;
    }
    // 3. Credentials — without the store's secret there is nothing to
    //    verify the signature against.
    const credential = await prisma.paymentCredential.findUnique({
        where: { storeId_provider: { storeId, provider: PROVIDER_KEY } },
    });
    if (credential === null) {
        throw new AppError(409, "PAYMENT_NOT_CONFIGURED", "This store has no payment credentials configured");
    }
    // 4. Signature verification over the EXACT raw bytes.
    const provider = providerFactory({
        publicKey: credential.publicKey,
        secretKey: decryptSecret(credential.secretKeyEncrypted),
    });
    if (!(await provider.verifyWebhookSignature(rawBody, signature))) {
        throw new AppError(401, "INVALID_SIGNATURE", "Webhook signature verification failed");
    }
    // 5. Processing.
    const eventData = {
        storeId,
        provider: PROVIDER_KEY,
        externalEventId: payload.data.id,
        payload: payload,
    };
    if (payload.event === "charge.failed") {
        return handleChargeFailed(orderId, orderStatus, eventData);
    }
    if (payload.event === "transfer.success") {
        return handleTransferSuccess(payoutId, storeId, eventData);
    }
    if (payload.event === "transfer.failed") {
        return handleTransferFailed(payoutId, storeId, eventData);
    }
    return handleChargeSuccess(orderId, orderStatus, eventData);
}
/**
 * Records an event as already-processed without touching the order —
 * used when the order is no longer PENDING (already paid, cancelled,
 * failed…). Never resurrects a finalized order and never decrements
 * stock twice.
 */
async function recordProcessedEvent(event) {
    try {
        await getPrismaClient().webhookEvent.create({
            data: { ...event, status: "PROCESSED", processedAt: new Date() },
        });
        return { outcome: "PROCESSED" };
    }
    catch (err) {
        if (isUniqueViolation(err)) {
            return { outcome: "DUPLICATE" };
        }
        throw err;
    }
}
async function handleChargeSuccess(orderId, orderStatus, event) {
    if (orderStatus !== "PENDING") {
        // Money arrived for an order that is no longer pending — record the
        // delivery and change nothing (no double decrement, no resurrection).
        return recordProcessedEvent(event);
    }
    const prisma = getPrismaClient();
    let paid = false;
    try {
        await prisma.$transaction(async (tx) => {
            // The event row is the race gate: a concurrent redelivery fails the
            // unique insert and the whole transaction (including the decrement)
            // never happens.
            const created = await tx.webhookEvent.create({ data: { ...event, status: "PENDING" } });
            // Guarded transition: only a still-PENDING order becomes PAID (and
            // the stock decrement + wallet credit only happen on that transition).
            paid = await applyChargeSuccessEffects(tx, orderId, event.storeId);
            await tx.webhookEvent.update({
                where: { id: created.id },
                data: { status: "PROCESSED", processedAt: new Date() },
            });
        });
    }
    catch (err) {
        if (isUniqueViolation(err)) {
            return { outcome: "DUPLICATE" };
        }
        throw err;
    }
    // The money is committed; the merchant alert fires after commit and is
    // best-effort (a send failure never fails the webhook response).
    if (paid) {
        await notifyPaymentReceived(defaultAlertSender(), event.storeId, NOTIFICATION_REF_TYPES.ORDER, orderId);
        await sendCustomerReceiptWithDefault(event.storeId, NOTIFICATION_REF_TYPES.ORDER, orderId);
    }
    return { outcome: "PROCESSED" };
}
/**
 * The guarded status→PAID transition plus the stock decrement, with NO
 * wallet credit. Shared by the CARD flow (applyChargeSuccessEffects adds the
 * wallet credit on top) and the manual bank-transfer confirm (which credits
 * nothing — the merchant records receipt out of band). The `fromStatus`
 * guard makes the claim atomic: exactly one caller wins the transition, so a
 * concurrent confirm + expiry sweep can't both move stock. Returns false when
 * the order was no longer in `fromStatus` (nothing changed).
 */
export async function markOrderPaidAndDecrementStock(tx, orderId, storeId, opts = {}) {
    const fromStatus = opts.fromStatus ?? "PENDING";
    const data = { status: "PAID", paidAt: new Date() };
    if (opts.amountPaid !== undefined) {
        data.amountPaid = opts.amountPaid;
    }
    const updated = await tx.order.updateMany({
        where: { id: orderId, storeId, status: fromStatus },
        data,
    });
    if (updated.count === 0) {
        return false;
    }
    const [order, lineItems] = await Promise.all([
        tx.order.findUnique({
            where: { id: orderId },
            select: { branchId: true, total: true },
        }),
        tx.orderLineItem.findMany({
            where: { orderId },
            select: { productId: true, variantId: true, quantity: true },
        }),
    ]);
    if (order === null || order.branchId === null) {
        throw new AppError(500, "ORDER_BRANCH_MISSING", "Order has no branch — cannot attribute its stock movement");
    }
    await recordSaleStockChanges(tx, lineItems.map((item) => ({
        storeId,
        branchId: order.branchId,
        productId: item.productId,
        variantId: item.variantId ?? undefined,
        quantityChange: -item.quantity,
    })));
    return true;
}
/**
 * The order-fulfillment half of charge.success, shared by the live
 * webhook handler and the admin replay path: the guarded PENDING→PAID
 * transition plus the stock decrement, then the wallet credit (the CARD
 * sale's money enters the wallet exactly when it's confirmed paid — same
 * transaction, so the credit can never be separated from the PAID
 * transition, or double-credited on replay). Returns false when the order
 * was no longer pending (nothing changed — no double decrement).
 */
export async function applyChargeSuccessEffects(tx, orderId, storeId) {
    const paid = await markOrderPaidAndDecrementStock(tx, orderId, storeId);
    if (!paid) {
        return false;
    }
    const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { branchId: true, total: true },
    });
    if (order?.branchId === null) {
        throw new AppError(500, "ORDER_BRANCH_MISSING", "Order has no branch — cannot attribute its stock movement");
    }
    await creditWallet(tx, storeId, {
        amount: order.total,
        orderId,
        source: "ORDER_PAYMENT",
    });
    return true;
}
async function handleChargeFailed(orderId, orderStatus, event) {
    if (orderStatus !== "PENDING") {
        return recordProcessedEvent(event);
    }
    const prisma = getPrismaClient();
    try {
        return await prisma.$transaction(async (tx) => {
            const created = await tx.webhookEvent.create({ data: { ...event, status: "PENDING" } });
            // Stock is NEVER touched on failure.
            await tx.order.updateMany({
                where: { id: orderId, status: "PENDING" },
                data: { status: "FAILED" },
            });
            await tx.webhookEvent.update({
                where: { id: created.id },
                data: { status: "PROCESSED", processedAt: new Date() },
            });
            return { outcome: "PROCESSED" };
        });
    }
    catch (err) {
        if (isUniqueViolation(err)) {
            return { outcome: "DUPLICATE" };
        }
        throw err;
    }
}
/**
 * Resolves the payout an event refers to, by transfer code (the
 * reliable key) falling back to the wd_… reference. 404 when neither
 * matches — nothing to verify against.
 */
async function resolvePayout(transferCode, reference) {
    const prisma = getPrismaClient();
    const payout = await prisma.payout.findFirst({
        where: {
            OR: [
                ...(transferCode !== undefined && transferCode.length > 0 ? [{ transferCode }] : []),
                { reference },
            ],
        },
    });
    if (payout === null) {
        throw new AppError(404, "PAYOUT_NOT_FOUND", "No payout matches this transfer");
    }
    return { id: payout.id, storeId: payout.storeId, status: payout.status };
}
/**
 * transfer.success: the money moved. Only a still-REQUESTED/PROCESSING
 * payout transitions to SUCCESS; an already-terminal payout is recorded
 * as processed with no further change (idempotent redelivery).
 */
async function handleTransferSuccess(payoutId, storeId, event) {
    const prisma = getPrismaClient();
    try {
        return await prisma.$transaction(async (tx) => {
            const created = await tx.webhookEvent.create({ data: { ...event, status: "PENDING" } });
            await tx.payout.updateMany({
                where: { id: payoutId, status: { in: ["REQUESTED", "PROCESSING"] } },
                data: { status: "SUCCESS", processedAt: new Date() },
            });
            await tx.webhookEvent.update({
                where: { id: created.id },
                data: { status: "PROCESSED", processedAt: new Date() },
            });
            return { outcome: "PROCESSED" };
        });
    }
    catch (err) {
        if (isUniqueViolation(err)) {
            return { outcome: "DUPLICATE" };
        }
        throw err;
    }
}
/**
 * transfer.failed: the money never moved. Only a still-REQUESTED/
 * PROCESSING payout transitions to FAILED — and the debit is reversed
 * ONLY on that transition (a WITHDRAWAL_REVERSAL credit), so a
 * redelivered failed event can never double-reverse.
 */
async function handleTransferFailed(payoutId, storeId, event) {
    const prisma = getPrismaClient();
    try {
        return await prisma.$transaction(async (tx) => {
            const created = await tx.webhookEvent.create({ data: { ...event, status: "PENDING" } });
            const amount = await tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
            const updated = await tx.payout.updateMany({
                where: { id: payoutId, status: { in: ["REQUESTED", "PROCESSING"] } },
                data: { status: "FAILED", processedAt: new Date() },
            });
            if (updated.count === 1) {
                await creditWallet(tx, storeId, {
                    amount: amount.amount,
                    payoutId,
                    source: "WITHDRAWAL_REVERSAL",
                });
            }
            await tx.webhookEvent.update({
                where: { id: created.id },
                data: { status: "PROCESSED", processedAt: new Date() },
            });
            return { outcome: "PROCESSED" };
        });
    }
    catch (err) {
        if (isUniqueViolation(err)) {
            return { outcome: "DUPLICATE" };
        }
        throw err;
    }
}
/**
 * Admin replay: re-runs a STORED webhook payload through the same
 * fulfillment pipeline (applyChargeSuccessEffects / the failed
 * transition) without re-verifying a signature and without creating a
 * new event row. Only events that were never PROCESSED (PENDING/FAILED,
 * no processedAt) are eligible — a processed event must never decrement
 * stock a second time.
 */
export async function reprocessWebhookEvent(eventId, providerFactory = defaultProviderFactory) {
    void providerFactory;
    const prisma = getPrismaClient();
    const event = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
    if (event === null) {
        throw new AppError(404, "ADMIN_EVENT_NOT_FOUND", "Webhook event not found");
    }
    if (event.status === "PROCESSED" || event.processedAt !== null) {
        throw new AppError(409, "WEBHOOK_ALREADY_PROCESSED", "This webhook was already processed; replays run no business effect");
    }
    let payload;
    try {
        payload = validateOrThrow(paystackWebhookSchema, event.payload);
    }
    catch {
        throw new AppError(400, "INVALID_PAYLOAD", "The stored webhook payload no longer parses");
    }
    const order = await prisma.order.findFirst({
        where: { paymentReference: payload.data.reference },
    });
    if (order === null) {
        throw new AppError(404, "ORDER_NOT_FOUND", "No order matches this payment reference");
    }
    // A non-pending order is finalized: replay records the delivery and
    // changes nothing (no double decrement, no resurrection).
    if (order.status !== "PENDING") {
        await prisma.webhookEvent.update({
            where: { id: event.id },
            data: { status: "PROCESSED", processedAt: new Date() },
        });
        return { outcome: "PROCESSED" };
    }
    await prisma.$transaction(async (tx) => {
        if (payload.event === "charge.failed") {
            await tx.order.updateMany({
                where: { id: order.id, status: "PENDING" },
                data: { status: "FAILED" },
            });
        }
        else {
            await applyChargeSuccessEffects(tx, order.id, event.storeId);
        }
        await tx.webhookEvent.update({
            where: { id: event.id },
            data: { status: "PROCESSED", processedAt: new Date() },
        });
    });
    // Admin replay of a payment that fulfilled an order — alert the owner
    // exactly like the live webhook path (deduped on the ORDER ref, so a
    // replay after a failed original send delivers the one missing alert).
    if (payload.event === "charge.success" && order.status === "PENDING") {
        await notifyPaymentReceived(defaultAlertSender(), event.storeId, NOTIFICATION_REF_TYPES.ORDER, order.id);
    }
    return { outcome: "PROCESSED" };
}
//# sourceMappingURL=service.js.map