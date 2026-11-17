import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { env } from "../../config/env.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { validateOrThrow } from "../../lib/validate.js";
import { logStoreActivity } from "../activity/service.js";
import { defaultAlertSender } from "../notifications/email.js";
import { notifyPaymentReceived, NOTIFICATION_REF_TYPES } from "../notifications/service.js";
import { sendCustomerReceiptWithDefault } from "../receipts/service.js";
import { invoiceCreateSchema, invoicePaymentSchema, invoiceUpdateSchema, listInvoicesParamsSchema, } from "./schemas.js";
/**
 * ============================================================
 * INVOICES SERVICE — money owed independent of fulfillment
 * ============================================================
 * The lifecycle: DRAFT (editable, deletable) -> ISSUED (locked,
 * payable; number + issuedAt stamped) -> PAID (automatic once
 * amountPaid = total) or VOID (from ISSUED, only with no payments).
 * Issuing never touches product stock — an invoice prices its own
 * line items at issue time.
 *
 * Payments settle through an append-only ledger (InvoicePayment rows,
 * DB trigger-enforced like CreditRepayment): invoice.amountPaid
 * advances per payment and the PAID transition is driven by the
 * ledger, never set by hand.
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
/** Cursor-paginated, newest-first invoice list with status/customer search. */
export async function listInvoices(storeId, rawParams) {
    const params = validateOrThrow(listInvoicesParamsSchema, rawParams);
    const prisma = getPrismaClient();
    const where = { storeId };
    if (params.status !== undefined)
        where.status = params.status;
    if (params.customerId !== undefined)
        where.customerId = params.customerId;
    if (params.q !== undefined) {
        where.customer = {
            OR: [
                { name: { contains: params.q, mode: "insensitive" } },
                { phone: { contains: params.q, mode: "insensitive" } },
            ],
        };
    }
    if (params.cursor !== undefined)
        where.id = { lt: params.cursor };
    const rows = await prisma.invoice.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: params.limit,
        select: {
            id: true,
            number: true,
            status: true,
            total: true,
            amountPaid: true,
            dueDate: true,
            createdAt: true,
            issuedAt: true,
            customer: { select: { id: true, name: true, phone: true } },
            lineItems: { select: { quantity: true } },
        },
    });
    const items = rows.map((row) => ({
        id: row.id,
        number: row.number,
        status: row.status,
        total: row.total.toFixed(2),
        amountPaid: row.amountPaid.toFixed(2),
        balanceDue: row.total.sub(row.amountPaid).toFixed(2),
        dueDate: row.dueDate,
        itemCount: row.lineItems.reduce((sum, line) => sum + line.quantity, 0),
        customer: row.customer,
        createdAt: row.createdAt,
        issuedAt: row.issuedAt,
    }));
    const nextCursor = rows.length === params.limit && rows.length > 0 ? rows[rows.length - 1].id : null;
    return { items, nextCursor };
}
/** The public link for an invoice, or null while it is still a DRAFT. */
function shareUrlFor(invoiceId, status, linkEnabled) {
    if (status === "DRAFT" || !linkEnabled)
        return null;
    return `${env.FRONTEND_URL.replace(/\/+$/, "")}/invoice/${invoiceId}`;
}
async function invoiceRow(storeId, invoiceId) {
    const prisma = getPrismaClient();
    const row = await prisma.invoice.findFirst({
        where: { id: invoiceId, storeId },
        select: {
            id: true,
            number: true,
            status: true,
            linkEnabled: true,
            total: true,
            amountPaid: true,
            dueDate: true,
            createdAt: true,
            issuedAt: true,
            customer: { select: { id: true, name: true, phone: true } },
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
                    unitPriceAtIssue: true,
                    product: { select: { id: true, name: true } },
                },
            },
        },
    });
    if (row === null) {
        throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice not found");
    }
    return row;
}
/** One invoice with its captured line items and payment timeline. */
export async function getInvoiceDetail(storeId, invoiceId) {
    const row = await invoiceRow(storeId, invoiceId);
    return {
        invoice: {
            id: row.id,
            number: row.number,
            status: row.status,
            total: row.total.toFixed(2),
            amountPaid: row.amountPaid.toFixed(2),
            balanceDue: row.total.sub(row.amountPaid).toFixed(2),
            dueDate: row.dueDate,
            customer: row.customer,
            createdAt: row.createdAt,
            issuedAt: row.issuedAt,
            shareUrl: shareUrlFor(row.id, row.status, row.linkEnabled),
            linkEnabled: row.linkEnabled,
        },
        payments: row.payments.map((payment) => ({
            id: payment.id,
            amount: payment.amount.toFixed(2),
            note: payment.note,
            recordedByName: recordedName(payment.recordedByStaff?.account ?? null),
            createdAt: payment.createdAt,
        })),
        lineItems: row.lineItems.map((line) => ({
            id: line.id,
            productId: line.product.id,
            productName: line.product.name,
            quantity: line.quantity,
            unitPriceAtIssue: line.unitPriceAtIssue.toFixed(2),
            lineTotal: line.unitPriceAtIssue.mul(line.quantity).toFixed(2),
        })),
    };
}
function totalOf(lineItems) {
    return lineItems.reduce((sum, line) => sum.add(new Prisma.Decimal(line.unitPriceAtIssue).mul(line.quantity)), new Prisma.Decimal(0));
}
/**
 * Verifies every line item's product belongs to the store. Missing
 * products surface as PRODUCT_NOT_FOUND (orders pattern).
 */
async function assertProductsInStore(tx, storeId, lineItems) {
    const ids = [...new Set(lineItems.map((line) => line.productId))];
    const found = await tx.product.findMany({
        where: { id: { in: ids }, storeId },
        select: { id: true },
    });
    if (found.length !== ids.length) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "A line item names a product outside this store");
    }
}
/** Creates a DRAFT invoice with its line items (prices captured here). */
export async function createInvoice(storeId, staffMemberId, rawInput) {
    const data = validateOrThrow(invoiceCreateSchema, rawInput);
    const prisma = getPrismaClient();
    const created = await prisma.$transaction(async (tx) => {
        const customer = await tx.customer.findFirst({
            where: { id: data.customerId, storeId },
            select: { id: true },
        });
        if (customer === null) {
            throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
        }
        await assertProductsInStore(tx, storeId, data.lineItems);
        const invoice = await tx.invoice.create({
            data: {
                storeId,
                customerId: data.customerId,
                total: totalOf(data.lineItems),
                dueDate: data.dueDate ?? null,
                lineItems: {
                    create: data.lineItems.map((line) => ({
                        storeId,
                        productId: line.productId,
                        quantity: line.quantity,
                        unitPriceAtIssue: new Prisma.Decimal(line.unitPriceAtIssue),
                    })),
                },
            },
            select: { id: true },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "invoice.created",
            detail: { invoiceId: invoice.id },
        });
        return invoice;
    });
    return getInvoiceDetail(storeId, created.id);
}
/** Replaces the line items of a DRAFT invoice and recomputes the total. */
export async function updateInvoice(storeId, staffMemberId, invoiceId, rawInput) {
    const data = validateOrThrow(invoiceUpdateSchema, rawInput);
    const prisma = getPrismaClient();
    const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.invoice.findFirst({
            where: { id: invoiceId, storeId },
            select: { id: true, status: true },
        });
        if (row === null) {
            throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice not found");
        }
        if (row.status !== "DRAFT") {
            throw new AppError(409, "INVOICE_NOT_DRAFT", "Only DRAFT invoices can be edited");
        }
        await assertProductsInStore(tx, storeId, data.lineItems);
        const invoice = await tx.invoice.update({
            where: { id: row.id },
            data: {
                total: totalOf(data.lineItems),
                dueDate: data.dueDate,
                lineItems: {
                    deleteMany: {},
                    create: data.lineItems.map((line) => ({
                        storeId,
                        productId: line.productId,
                        quantity: line.quantity,
                        unitPriceAtIssue: new Prisma.Decimal(line.unitPriceAtIssue),
                    })),
                },
            },
            select: { id: true },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "invoice.updated",
            detail: { invoiceId: invoice.id },
        });
        return invoice;
    });
    return getInvoiceDetail(storeId, updated.id);
}
/** Permanently deletes a DRAFT invoice (cascades its line items). */
export async function deleteInvoice(storeId, staffMemberId, invoiceId) {
    const prisma = getPrismaClient();
    await prisma.$transaction(async (tx) => {
        const row = await tx.invoice.findFirst({
            where: { id: invoiceId, storeId },
            select: { id: true, status: true },
        });
        if (row === null) {
            throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice not found");
        }
        if (row.status !== "DRAFT") {
            throw new AppError(409, "INVOICE_NOT_DRAFT", "Only DRAFT invoices can be deleted");
        }
        await tx.invoice.delete({ where: { id: row.id } });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "invoice.deleted",
            detail: { invoiceId },
        });
    });
}
/**
 * Transitions DRAFT -> ISSUED: stamps issuedAt and assigns the next
 * store-sequential INV-#### number. The counter is bumped atomically
 * inside the same transaction, so concurrent issues never collide.
 */
export async function issueInvoice(storeId, staffMemberId, invoiceId) {
    const prisma = getPrismaClient();
    const issued = await prisma.$transaction(async (tx) => {
        const row = await tx.invoice.findFirst({
            where: { id: invoiceId, storeId },
            select: { id: true, status: true },
        });
        if (row === null) {
            throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice not found");
        }
        if (row.status !== "DRAFT") {
            throw new AppError(409, "INVOICE_NOT_DRAFT", "Only DRAFT invoices can be issued");
        }
        const store = await tx.store.update({
            where: { id: storeId },
            data: { invoiceCounter: { increment: 1 } },
            select: { invoiceCounter: true },
        });
        const invoice = await tx.invoice.update({
            where: { id: row.id },
            data: {
                status: "ISSUED",
                number: `INV-${padNumber(store.invoiceCounter)}`,
                issuedAt: new Date(),
            },
            select: { id: true },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "invoice.issued",
            detail: { invoiceId: invoice.id, number: `INV-${padNumber(store.invoiceCounter)}` },
        });
        return invoice;
    });
    return getInvoiceDetail(storeId, issued.id);
}
/**
 * Transitions ISSUED -> VOID. Only with no payments on the books —
 * voiding money would orphan it. Voided invoices are terminal.
 */
export async function voidInvoice(storeId, staffMemberId, invoiceId) {
    const prisma = getPrismaClient();
    const voided = await prisma.$transaction(async (tx) => {
        const row = await tx.invoice.findFirst({
            where: { id: invoiceId, storeId },
            select: { id: true, status: true },
        });
        if (row === null) {
            throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice not found");
        }
        if (row.status !== "ISSUED") {
            throw new AppError(409, "INVOICE_NOT_ISSUED", "Only ISSUED invoices can be voided");
        }
        const paymentCount = await tx.invoicePayment.count({ where: { invoiceId: row.id } });
        if (paymentCount > 0) {
            throw new AppError(409, "INVOICE_HAS_PAYMENTS", "An invoice with payments cannot be voided");
        }
        const invoice = await tx.invoice.update({
            where: { id: row.id },
            data: { status: "VOID" },
            select: { id: true },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "invoice.voided",
            detail: { invoiceId: invoice.id },
        });
        return invoice;
    });
    return getInvoiceDetail(storeId, voided.id);
}
/**
 * Records a payment against an ISSUED invoice: one immutable
 * InvoicePayment row, amountPaid advanced, PAID reached automatically
 * when the balance settles. Over-payment is rejected upfront.
 */
export async function recordInvoicePayment(storeId, staffMemberId, invoiceId, rawInput) {
    const data = validateOrThrow(invoicePaymentSchema, rawInput);
    const amount = new Prisma.Decimal(data.amount);
    const prisma = getPrismaClient();
    let paymentId;
    const result = await prisma.$transaction(async (tx) => {
        const row = await tx.invoice.findFirst({
            where: { id: invoiceId, storeId },
            select: { id: true, status: true, total: true, amountPaid: true },
        });
        if (row === null) {
            throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice not found");
        }
        if (row.status !== "ISSUED") {
            throw new AppError(409, "INVOICE_NOT_ISSUED", "Only ISSUED invoices can be paid");
        }
        const totalOutstanding = row.total.sub(row.amountPaid);
        if (amount.greaterThan(totalOutstanding)) {
            throw new AppError(409, "PAYMENT_EXCEEDS_BALANCE", `Payment exceeds the outstanding balance of ${totalOutstanding.toFixed(2)}`);
        }
        const newPaid = row.amountPaid.add(amount);
        const status = newPaid.equals(row.total) ? "PAID" : "ISSUED";
        const payment = await tx.invoicePayment.create({
            data: {
                storeId,
                invoiceId: row.id,
                amount,
                note: data.note ?? null,
                recordedByStaffId: staffMemberId ?? null,
            },
            select: { id: true },
        });
        paymentId = payment.id;
        await tx.invoice.update({
            where: { id: row.id },
            data: { amountPaid: newPaid, status },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: "invoice.payment.recorded",
            detail: { invoiceId: row.id, paymentId: payment.id, amount: data.amount },
        });
        return {
            invoiceId: row.id,
            status,
            allocated: amount.toFixed(2),
            balanceDue: totalOutstanding.sub(amount).toFixed(2),
            totalOutstanding: totalOutstanding.toFixed(2),
        };
    });
    // Money is committed; alert the owner (best-effort — a send failure
    // never surfaces here). Deduped on the payment ledger row, so a
    // partial-payment series alerts per installment, not per invoice.
    if (paymentId !== undefined) {
        await notifyPaymentReceived(defaultAlertSender(), storeId, NOTIFICATION_REF_TYPES.INVOICE_PAYMENT, paymentId);
        await sendCustomerReceiptWithDefault(storeId, NOTIFICATION_REF_TYPES.INVOICE_PAYMENT, paymentId);
    }
    return result;
}
/**
 * Toggles the public share link for an invoice. Disabling kills the
 * customer-facing link (the public read 404s) WITHOUT voiding the
 * invoice — a financial-side-effect-free way to revoke a link that was
 * shared too widely. Re-enabling brings it back. Only issued (or paid /
 * voided) invoices can be toggled; drafts have no link to toggle.
 */
export async function setInvoiceLinkEnabled(storeId, staffMemberId, invoiceId, enabled) {
    const prisma = getPrismaClient();
    await prisma.$transaction(async (tx) => {
        const row = await tx.invoice.findFirst({
            where: { id: invoiceId, storeId },
            select: { id: true, status: true },
        });
        if (row === null) {
            throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice not found");
        }
        if (row.status === "DRAFT") {
            throw new AppError(409, "INVOICE_NOT_ISSUED", "Only issued invoices have a share link");
        }
        await tx.invoice.update({
            where: { id: row.id },
            data: { linkEnabled: enabled },
        });
        await logStoreActivity(tx, {
            storeId,
            staffMemberId: staffMemberId ?? null,
            action: enabled ? "invoice.link.enabled" : "invoice.link.disabled",
            detail: { invoiceId },
        });
    });
    return getInvoiceDetail(storeId, invoiceId);
}
/**
 * Resolves an invoice for a customer who holds only its link. DRAFT
 * and unknown invoices are indistinguishable (both 404) so a
 * never-issued link leaks nothing about whether an invoice exists.
 */
export async function getPublicInvoice(invoiceId) {
    const prisma = getPrismaClient();
    const row = await prisma.invoice.findFirst({
        where: { id: invoiceId },
        select: {
            id: true,
            storeId: true,
            number: true,
            status: true,
            linkEnabled: true,
            total: true,
            amountPaid: true,
            dueDate: true,
            issuedAt: true,
            store: { select: { name: true, currency: true } },
            customer: { select: { name: true } },
            lineItems: {
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    quantity: true,
                    unitPriceAtIssue: true,
                    product: { select: { name: true } },
                },
            },
        },
    });
    if (row === null || row.status === "DRAFT" || row.linkEnabled === false) {
        // A DRAFT invoice, an id that never existed, or a link the merchant
        // has switched off are all indistinguishable (404) so the public
        // endpoint never leaks whether an invoice exists or was disabled.
        throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice not found");
    }
    const totalOutstanding = row.total.sub(row.amountPaid);
    const isPayable = row.status === "ISSUED" && totalOutstanding.greaterThan(0);
    // The account number is only exposed while a payment is still expected.
    // A settled or voided invoice must never surface a place to send money.
    let bankDetails = null;
    if (isPayable) {
        const bank = await prisma.bankAccount.findFirst({
            where: { storeId: row.storeId, isDefault: true, accountNumber: { not: null } },
            select: { bankName: true, accountName: true, accountNumber: true },
        });
        if (bank !== null && bank.accountNumber !== null) {
            bankDetails = {
                bankName: bank.bankName,
                accountName: bank.accountName,
                accountNumber: bank.accountNumber,
            };
        }
    }
    return {
        id: row.id,
        number: row.number,
        status: row.status,
        storeName: row.store.name,
        currency: row.store.currency,
        customerName: row.customer.name,
        total: row.total.toFixed(2),
        amountPaid: row.amountPaid.toFixed(2),
        balanceDue: totalOutstanding.toFixed(2),
        dueDate: row.dueDate,
        issuedAt: row.issuedAt,
        isPayable,
        bankDetails,
        lineItems: row.lineItems.map((line) => ({
            id: line.id,
            productName: line.product.name,
            quantity: line.quantity,
            unitPrice: line.unitPriceAtIssue.toFixed(2),
            lineTotal: line.unitPriceAtIssue.mul(line.quantity).toFixed(2),
        })),
    };
}
//# sourceMappingURL=service.js.map