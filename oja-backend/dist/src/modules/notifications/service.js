import { env } from "../../config/env.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { DAY_MS } from "../analytics/constants.js";
import { EXPIRING_WINDOW_DAYS } from "../overview/service.js";
import { NOTIFICATION_TOGGLE_KEYS } from "../settings/schemas.js";
import { buildExpiringSoonAlertEmail, buildLowStockAlertEmail, buildPaymentAlertEmail, buildTestAlertEmail, buildSupportReplyEmail, defaultAlertSender, } from "./email.js";
/**
 * ============================================================
 * MERCHANT ALERTS — the engine behind the notification toggles
 * ============================================================
 *
 * The settings module stores the toggles; this module turns them into
 * emails. Two paths:
 *
 * 1. SCHEDULED SWEEP (sweepAlerts) — LOW_STOCK and EXPIRING_SOON.
 *    Runs every ALERT_SWEEP_INTERVAL_MS from the process scheduler
 *    (startAlertScheduler in server.ts). One consolidated email per
 *    store per kind per run. Idempotent by construction: a dispatched
 *    condition is never emailed twice (dedup on NotificationDispatch),
 *    and low stock re-alerts only when it has WORSENED since the last
 *    send.
 *
 * 2. EVENT-DRIVEN (notifyPaymentReceived) — PAYMENT_RECEIVED. Fired by
 *    the money flows the moment a payment lands: checkout webhook,
 *    credit repayment, invoice payment. Send-once per financial row.
 *
 * Every send is best-effort: failures are logged, never thrown. A
 * failed send leaves no dispatch row, so the next run retries; the
 * payment path is NEVER blocked by email — the money is already
 * recorded when the hook fires.
 */
/** refType values on NotificationDispatch rows (what refId points at). */
export const NOTIFICATION_REF_TYPES = {
    BRANCH_STOCK: "BRANCH_STOCK",
    PRODUCT: "PRODUCT",
    ORDER: "ORDER",
    CREDIT_REPAYMENT: "CREDIT_REPAYMENT",
    INVOICE_PAYMENT: "INVOICE_PAYMENT",
    TICKET_MESSAGE: "TICKET_MESSAGE",
};
/** Best-effort, send-once owner alert for an admin support response. */
export async function notifySupportReply(sender, storeId, ticketId, messageId) {
    const prisma = getPrismaClient();
    try {
        const existing = await prisma.notificationDispatch.findUnique({
            where: {
                storeId_kind_refType_refId: {
                    storeId,
                    kind: "SUPPORT_REPLY",
                    refType: NOTIFICATION_REF_TYPES.TICKET_MESSAGE,
                    refId: messageId,
                },
            },
        });
        if (existing)
            return;
        const ticket = await prisma.supportTicket.findFirst({
            where: { id: ticketId, storeId },
            select: {
                subject: true,
                store: {
                    select: { name: true, owner: { select: { account: { select: { email: true } } } } },
                },
            },
        });
        if (!ticket?.store.owner)
            return;
        await sender.sendAlert(ticket.store.owner.account.email, buildSupportReplyEmail(ticket.store.name, ticket.subject));
        await prisma.notificationDispatch.createMany({
            data: [
                {
                    storeId,
                    kind: "SUPPORT_REPLY",
                    refType: NOTIFICATION_REF_TYPES.TICKET_MESSAGE,
                    refId: messageId,
                    snapshot: { ticketId, subject: ticket.subject },
                },
            ],
            skipDuplicates: true,
        });
    }
    catch (err) {
        console.error(`[support] reply notification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function isToggleEnabled(settings, key) {
    return settings[key];
}
async function loadRecipients() {
    const stores = await getPrismaClient().store.findMany({
        select: {
            id: true,
            name: true,
            notificationSettings: true,
            owner: { select: { account: { select: { email: true } } } },
        },
    });
    const recipients = [];
    for (const store of stores) {
        // A store without an owner has nobody to alert — skip silently.
        if (store.owner === null)
            continue;
        const raw = store.notificationSettings;
        const stored = (typeof raw === "object" && raw !== null ? raw : {});
        const settings = {
            lowStockAlerts: true,
            paymentAlerts: true,
            expiringSoonAlerts: true,
            receiptsEnabled: true,
        };
        for (const key of NOTIFICATION_TOGGLE_KEYS) {
            const value = stored[key];
            if (typeof value === "boolean")
                settings[key] = value;
        }
        recipients.push({
            storeId: store.id,
            storeName: store.name,
            settings,
            ownerEmail: store.owner.account.email,
        });
    }
    return recipients;
}
async function findLowStockCandidates(storeId) {
    const rows = await getPrismaClient().branchStock.findMany({
        where: { storeId },
        select: {
            id: true,
            quantity: true,
            branch: { select: { name: true } },
            product: {
                select: { id: true, name: true, lowStockThreshold: true, deletedAt: true },
            },
        },
    });
    return rows
        .filter((row) => row.product.deletedAt === null)
        .filter((row) => row.quantity <= 0 ||
        (row.product.lowStockThreshold !== null && row.quantity <= row.product.lowStockThreshold))
        .map((row) => ({
        branchStockId: row.id,
        productId: row.product.id,
        productName: row.product.name,
        branchName: row.branch.name,
        quantity: row.quantity,
        threshold: row.product.lowStockThreshold,
    }))
        .sort((a, b) => a.quantity - b.quantity);
}
async function findExpiringSoonCandidates(storeId, now) {
    const windowEnd = new Date(now.getTime() + EXPIRING_WINDOW_DAYS * DAY_MS);
    const rows = await getPrismaClient().product.findMany({
        where: {
            storeId,
            deletedAt: null,
            expiryDate: { gte: now, lt: windowEnd },
        },
        select: { id: true, name: true, expiryDate: true },
        orderBy: { expiryDate: "asc" },
    });
    return rows.map((row) => ({
        productId: row.id,
        productName: row.name,
        expiryDate: row.expiryDate,
    }));
}
/**
 * The scheduled sweep. Scans every store, honors the notification
 * toggles, and emails the owner one consolidated alert per kind.
 * Idempotent: re-running it never duplicates a send. Throws nothing —
 * a failing store never blocks the rest of the sweep.
 */
export async function sweepAlerts(sender, now = new Date()) {
    const prisma = getPrismaClient();
    const recipients = await loadRecipients();
    let emailsSent = 0;
    for (const recipient of recipients) {
        try {
            if (isToggleEnabled(recipient.settings, "lowStockAlerts")) {
                const candidates = await findLowStockCandidates(recipient.storeId);
                const existing = await prisma.notificationDispatch.findMany({
                    where: { storeId: recipient.storeId, kind: "LOW_STOCK" },
                    select: { refId: true, sentQuantity: true },
                });
                const previous = new Map(existing.map((row) => [row.refId, row.sentQuantity]));
                // Re-alert rule: alert when there is no prior dispatch for the
                // ref, or when stock has WORSENED since (previous send quantity
                // strictly above the current quantity). A restock + re-drop below
                // the prior alert level is a NEW warning; the same level never
                // re-emails.
                const toAlert = candidates.filter((candidate) => {
                    const lastSent = previous.get(candidate.branchStockId);
                    return lastSent === undefined || lastSent === null || lastSent > candidate.quantity;
                });
                if (toAlert.length > 0) {
                    const items = toAlert.map((candidate) => ({
                        productName: candidate.productName,
                        branchName: candidate.branchName,
                        quantity: candidate.quantity,
                        threshold: candidate.threshold,
                    }));
                    await sender.sendAlert(recipient.ownerEmail, buildLowStockAlertEmail(recipient.storeName, items));
                    for (const candidate of toAlert) {
                        await prisma.notificationDispatch.upsert({
                            where: {
                                storeId_kind_refType_refId: {
                                    storeId: recipient.storeId,
                                    kind: "LOW_STOCK",
                                    refType: NOTIFICATION_REF_TYPES.BRANCH_STOCK,
                                    refId: candidate.branchStockId,
                                },
                            },
                            create: {
                                storeId: recipient.storeId,
                                kind: "LOW_STOCK",
                                refType: NOTIFICATION_REF_TYPES.BRANCH_STOCK,
                                refId: candidate.branchStockId,
                                sentQuantity: candidate.quantity,
                                snapshot: {
                                    productName: candidate.productName,
                                    branchName: candidate.branchName,
                                    quantity: candidate.quantity,
                                    threshold: candidate.threshold,
                                },
                                sentAt: now,
                            },
                            update: {
                                sentQuantity: candidate.quantity,
                                snapshot: {
                                    productName: candidate.productName,
                                    branchName: candidate.branchName,
                                    quantity: candidate.quantity,
                                    threshold: candidate.threshold,
                                },
                                sentAt: now,
                            },
                        });
                    }
                    emailsSent += 1;
                }
            }
            if (isToggleEnabled(recipient.settings, "expiringSoonAlerts")) {
                const candidates = await findExpiringSoonCandidates(recipient.storeId, now);
                const existing = await prisma.notificationDispatch.findMany({
                    where: {
                        storeId: recipient.storeId,
                        kind: "EXPIRING_SOON",
                        refType: NOTIFICATION_REF_TYPES.PRODUCT,
                        refId: { in: candidates.map((candidate) => candidate.productId) },
                    },
                    select: { refId: true },
                });
                const alreadySent = new Set(existing.map((row) => row.refId));
                const toAlert = candidates.filter((candidate) => !alreadySent.has(candidate.productId));
                if (toAlert.length > 0) {
                    const items = toAlert.map((candidate) => ({
                        productName: candidate.productName,
                        expiryDate: candidate.expiryDate,
                    }));
                    await sender.sendAlert(recipient.ownerEmail, buildExpiringSoonAlertEmail(recipient.storeName, items));
                    await prisma.notificationDispatch.createMany({
                        data: toAlert.map((candidate) => ({
                            storeId: recipient.storeId,
                            kind: "EXPIRING_SOON",
                            refType: NOTIFICATION_REF_TYPES.PRODUCT,
                            refId: candidate.productId,
                            snapshot: {
                                productName: candidate.productName,
                                expiryDate: candidate.expiryDate.toISOString(),
                            },
                            sentAt: now,
                        })),
                        skipDuplicates: true,
                    });
                    emailsSent += 1;
                }
            }
        }
        catch (err) {
            console.error(`[alerts] sweep failed for store ${recipient.storeId}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { storesScanned: recipients.length, emailsSent };
}
async function loadPaymentDetail(storeId, refType, refId) {
    const prisma = getPrismaClient();
    if (refType === NOTIFICATION_REF_TYPES.ORDER) {
        const order = await prisma.order.findFirst({
            where: { id: refId, storeId },
            select: { total: true, customer: { select: { name: true } } },
        });
        if (order === null)
            return null;
        return {
            label: "Checkout payment",
            amount: order.total.toFixed(2),
            detail: `Customer: ${order.customer.name}`,
        };
    }
    if (refType === NOTIFICATION_REF_TYPES.CREDIT_REPAYMENT) {
        const repayment = await prisma.creditRepayment.findFirst({
            where: { id: refId, storeId },
            select: { amount: true, order: { select: { customer: { select: { name: true } } } } },
        });
        if (repayment === null)
            return null;
        return {
            label: "Credit repayment",
            amount: repayment.amount.toFixed(2),
            detail: `Customer: ${repayment.order.customer.name}`,
        };
    }
    if (refType === NOTIFICATION_REF_TYPES.INVOICE_PAYMENT) {
        const payment = await prisma.invoicePayment.findFirst({
            where: { id: refId, storeId },
            select: {
                amount: true,
                invoice: { select: { number: true, customer: { select: { name: true } } } },
            },
        });
        if (payment === null)
            return null;
        return {
            label: "Invoice payment",
            amount: payment.amount.toFixed(2),
            detail: `Invoice ${payment.invoice.number ?? "—"} — Customer: ${payment.invoice.customer.name}`,
        };
    }
    return null;
}
/**
 * Event-driven payment alert: fired by the money flows (checkout webhook,
 * credit repayment, invoice payment) AFTER their transaction commits.
 * Best-effort and send-once per financial row; a store with the toggle
 * off (or no owner email) is a silent no-op.
 */
export async function notifyPaymentReceived(sender, storeId, refType, refId) {
    const prisma = getPrismaClient();
    try {
        const [store, existing] = await Promise.all([
            prisma.store.findUnique({
                where: { id: storeId },
                select: {
                    name: true,
                    notificationSettings: true,
                    owner: { select: { account: { select: { email: true } } } },
                },
            }),
            prisma.notificationDispatch.findUnique({
                where: {
                    storeId_kind_refType_refId: {
                        storeId,
                        kind: "PAYMENT_RECEIVED",
                        refType,
                        refId,
                    },
                },
            }),
        ]);
        if (store === null || store.owner === null || existing !== null)
            return;
        const raw = store.notificationSettings;
        const stored = (typeof raw === "object" && raw !== null ? raw : {});
        if (typeof stored.paymentAlerts === "boolean" && stored.paymentAlerts === false)
            return;
        const detail = await loadPaymentDetail(storeId, refType, refId);
        if (detail === null)
            return;
        await sender.sendAlert(store.owner.account.email, buildPaymentAlertEmail(store.name, detail));
        await prisma.notificationDispatch.createMany({
            data: [
                {
                    storeId,
                    kind: "PAYMENT_RECEIVED",
                    refType,
                    refId,
                    snapshot: detail,
                    sentAt: new Date(),
                },
            ],
            skipDuplicates: true,
        });
    }
    catch (err) {
        // Money is already recorded; an alert failure must never bubble up.
        console.error(`[alerts] payment alert failed (${refType} ${refId}): ${err instanceof Error ? err.message : String(err)}`);
    }
}
/**
 * Event-driven "payment claimed" alert: fired when a customer clicks "I
 * have paid" on a manual bank-transfer order. Best-effort and send-once per
 * order (the unique constraint guards against duplicate sends); a store with
 * the toggle off (or no owner email) is a silent no-op. The dispatch row is
 * written BEFORE the send so the claim is always recorded even if the email
 * transport is unavailable.
 */
export async function notifyPaymentClaimed(sender, storeId, refId) {
    const prisma = getPrismaClient();
    try {
        const [store, existing] = await Promise.all([
            prisma.store.findUnique({
                where: { id: storeId },
                select: {
                    name: true,
                    notificationSettings: true,
                    owner: { select: { account: { select: { email: true } } } },
                },
            }),
            prisma.notificationDispatch.findUnique({
                where: {
                    storeId_kind_refType_refId: {
                        storeId,
                        kind: "PAYMENT_CLAIMED",
                        refType: NOTIFICATION_REF_TYPES.ORDER,
                        refId,
                    },
                },
            }),
        ]);
        if (store === null || store.owner === null || existing !== null)
            return;
        const raw = store.notificationSettings;
        const stored = (typeof raw === "object" && raw !== null ? raw : {});
        if (typeof stored.paymentAlerts === "boolean" && stored.paymentAlerts === false)
            return;
        const detail = await loadPaymentDetail(storeId, NOTIFICATION_REF_TYPES.ORDER, refId);
        if (detail === null)
            return;
        // Record the claim first so it survives a transport failure.
        await prisma.notificationDispatch.createMany({
            data: [
                {
                    storeId,
                    kind: "PAYMENT_CLAIMED",
                    refType: NOTIFICATION_REF_TYPES.ORDER,
                    refId,
                    snapshot: {
                        ...detail,
                        label: "Bank transfer claimed — confirm receipt",
                    },
                    sentAt: new Date(),
                },
            ],
            skipDuplicates: true,
        });
        await sender.sendAlert(store.owner.account.email, buildPaymentAlertEmail(store.name, {
            ...detail,
            label: "Bank transfer claimed — confirm receipt",
        }));
    }
    catch (err) {
        console.error(`[alerts] payment-claimed alert failed (ORDER ${refId}): ${err instanceof Error ? err.message : String(err)}`);
    }
}
/**
 * Recent dispatches, newest first, cursor-paginated on the id tie-break
 * (same convention as the invoices list). Optional kind filter.
 */
export async function listDispatches(storeId, params) {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const prisma = getPrismaClient();
    const where = { storeId };
    if (params.kind !== undefined)
        where.kind = params.kind;
    if (params.cursor !== undefined)
        where.id = { lt: params.cursor };
    const rows = await prisma.notificationDispatch.findMany({
        where,
        orderBy: [{ sentAt: "desc" }, { id: "desc" }],
        take: limit,
        select: {
            id: true,
            kind: true,
            refType: true,
            refId: true,
            sentQuantity: true,
            snapshot: true,
            sentAt: true,
        },
    });
    const nextCursor = rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null;
    return { dispatches: rows, nextCursor };
}
/**
 * The scheduled engine: an in-process interval that runs the sweep.
 * No-op under NODE_ENV=test (tests invoke sweepAlerts directly). The
 * timer is unref'd so a server with no other work can exit cleanly.
 */
export function startAlertScheduler() {
    if (process.env.NODE_ENV === "test")
        return;
    if (env.ALERT_SWEEP_INTERVAL_MS <= 0)
        return;
    const run = () => {
        sweepAlerts(defaultAlertSender()).catch((err) => {
            console.error(`[alerts] scheduled sweep failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    };
    run();
    const timer = setInterval(run, env.ALERT_SWEEP_INTERVAL_MS);
    timer.unref();
}
/**
 * POST /api/dashboard/notifications/test — one test email to the owner,
 * regardless of toggles. Never writes a dispatch row.
 */
export async function sendTestAlert(sender, storeId) {
    const store = await getPrismaClient().store.findUnique({
        where: { id: storeId },
        select: {
            name: true,
            owner: { select: { account: { select: { email: true } } } },
        },
    });
    if (store === null || store.owner === null) {
        throw new AppError(404, "NOT_FOUND", "This store has no owner to alert");
    }
    await sender.sendAlert(store.owner.account.email, buildTestAlertEmail(store.name));
    return { sent: true, to: store.owner.account.email };
}
//# sourceMappingURL=service.js.map