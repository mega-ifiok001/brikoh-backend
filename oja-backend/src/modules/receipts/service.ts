import type { Prisma } from "../../../generated/prisma/client.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { NOTIFICATION_REF_TYPES } from "../notifications/service.js";
import { loadMerchantBranding } from "./branding.js";
import { buildReceiptEmail, type ReceiptData, type ReceiptLine } from "./email.js";
import { defaultReceiptSender, type ReceiptEmailSender } from "./sender.js";

export type { ReceiptEmailSender };

/**
 * ============================================================
 * CUSTOMER RECEIPTS — merchant-branded email after a sale
 * ============================================================
 * Fired from the money paths AFTER their transaction commits (order
 * payment webhook, bank-transfer confirmation, POS instant sale, invoice
 * payment). Best-effort: a failure is logged and never thrown, so email
 * can never affect the money. Send-once per (store, REF receipt, source
 * row) via the NotificationDispatch unique key, so webhook redeliveries
 * never duplicate a receipt. Skipped when the store turned receipts off
 * or the sale captured no recipient email.
 * ============================================================
 */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Receipts are enabled unless the merchant explicitly turned them off. */
async function receiptsEnabled(storeId: string): Promise<boolean> {
  const store = await getPrismaClient().store.findUnique({
    where: { id: storeId },
    select: { notificationSettings: true },
  });
  if (store === null) return false;
  return asRecord(store.notificationSettings).receiptsEnabled !== false;
}

async function loadOrderReceipt(
  storeId: string,
  orderId: string,
): Promise<{ recipient: string; receipt: ReceiptData } | null> {
  const order = await getPrismaClient().order.findFirst({
    where: { id: orderId, storeId },
    select: {
      receiptEmail: true,
      orderNumber: true,
      total: true,
      amountPaid: true,
      paymentMethod: true,
      deliveryFee: true,
      paidAt: true,
      createdAt: true,
      customer: { select: { email: true } },
      lineItems: {
        orderBy: { createdAt: "asc" },
        select: {
          quantity: true,
          unitPriceAtPurchase: true,
          product: { select: { name: true } },
          variant: { select: { name: true } },
        },
      },
    },
  });
  if (order === null) return null;

  const recipient = order.receiptEmail ?? order.customer.email;
  if (recipient === null || recipient.length === 0) return null;

  const amountPaid = order.amountPaid ?? order.total;
  const lines: ReceiptLine[] = order.lineItems.map((line) => ({
    // Show the picked variant ("Polo Shirt — Red / M") when the line names one.
    name:
      line.variant !== null && line.variant !== undefined
        ? `${line.product.name} — ${line.variant.name}`
        : line.product.name,
    quantity: line.quantity,
    unitPrice: line.unitPriceAtPurchase.toFixed(2),
    lineTotal: line.unitPriceAtPurchase.mul(line.quantity).toFixed(2),
  }));

  return {
    recipient,
    receipt: {
      kind: "ORDER",
      reference: order.orderNumber,
      date: order.paidAt ?? order.createdAt,
      lines,
      total: order.total.toFixed(2),
      amountPaid: amountPaid.toFixed(2),
      balanceDue: order.total.sub(amountPaid).toFixed(2),
      paymentMethod: order.paymentMethod,
      deliveryFee: order.deliveryFee.toFixed(2),
    },
  };
}

async function loadInvoiceReceipt(
  storeId: string,
  paymentId: string,
): Promise<{ recipient: string; receipt: ReceiptData } | null> {
  const payment = await getPrismaClient().invoicePayment.findFirst({
    where: { id: paymentId, storeId },
    select: {
      createdAt: true,
      invoice: {
        select: {
          number: true,
          total: true,
          amountPaid: true,
          customer: { select: { email: true } },
          lineItems: {
            orderBy: { createdAt: "asc" },
            select: {
              quantity: true,
              unitPriceAtIssue: true,
              product: { select: { name: true } },
            },
          },
        },
      },
    },
  });
  if (payment === null) return null;

  const recipient = payment.invoice.customer.email;
  if (recipient === null || recipient.length === 0) return null;

  const lines: ReceiptLine[] = payment.invoice.lineItems.map((line) => ({
    name: line.product.name,
    quantity: line.quantity,
    unitPrice: line.unitPriceAtIssue.toFixed(2),
    lineTotal: line.unitPriceAtIssue.mul(line.quantity).toFixed(2),
  }));

  return {
    recipient,
    receipt: {
      kind: "INVOICE",
      reference: payment.invoice.number ?? "INV",
      date: payment.createdAt,
      lines,
      total: payment.invoice.total.toFixed(2),
      amountPaid: payment.invoice.amountPaid.toFixed(2),
      balanceDue: payment.invoice.total.sub(payment.invoice.amountPaid).toFixed(2),
      paymentMethod: null,
    },
  };
}

/**
 * Loads what a receipt needs for the given source row, or null when the
 * row/recipient is missing.
 */
async function loadReceipt(
  storeId: string,
  refType: string,
  refId: string,
): Promise<{ recipient: string; receipt: ReceiptData } | null> {
  if (refType === NOTIFICATION_REF_TYPES.ORDER) {
    return loadOrderReceipt(storeId, refId);
  }
  if (refType === NOTIFICATION_REF_TYPES.INVOICE_PAYMENT) {
    return loadInvoiceReceipt(storeId, refId);
  }
  return null;
}

export async function sendCustomerReceipt(
  sender: ReceiptEmailSender,
  storeId: string,
  refType: string,
  refId: string,
): Promise<void> {
  try {
    if (!(await receiptsEnabled(storeId))) return;

    // Dedup gate — a receipt for this source row is never sent twice.
    const prisma = getPrismaClient();
    const existing = await prisma.notificationDispatch.findUnique({
      where: {
        storeId_kind_refType_refId: { storeId, kind: "RECEIPT", refType, refId },
      },
    });
    if (existing !== null) return;

    const data = await loadReceipt(storeId, refType, refId);
    if (data === null) return;

    const branding = await loadMerchantBranding(storeId);
    const email = buildReceiptEmail(branding, data.receipt);

    await sender.send(data.recipient, email, {
      fromName: branding.storeName,
      replyTo: branding.replyTo,
    });

    await prisma.notificationDispatch.createMany({
      data: [
        {
          storeId,
          kind: "RECEIPT",
          refType,
          refId,
          snapshot: data.receipt as unknown as Prisma.InputJsonValue,
          sentAt: new Date(),
        },
      ],
      skipDuplicates: true,
    });
  } catch (err) {
    // Money is already recorded; a receipt failure must never bubble up.
    console.error(
      `[receipts] receipt failed (${refType} ${refId}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Convenience wrapper using the wired sender (call sites stay terse). */
export async function sendCustomerReceiptWithDefault(
  storeId: string,
  refType: string,
  refId: string,
): Promise<void> {
  await sendCustomerReceipt(defaultReceiptSender(), storeId, refType, refId);
}
