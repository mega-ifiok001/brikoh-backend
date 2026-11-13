import { escapeHtml } from "../../lib/email/layout.js";
import { renderMerchantEmailLayout } from "../../lib/email/merchantLayout.js";
import { formatHumanDate } from "../../lib/format-date.js";
import { formatMoney } from "../../lib/format-currency.js";
import type { MerchantBranding } from "./branding.js";

/**
 * Customer receipt email. Simple itemised body + totals, rendered with
 * the merchant's own branding (see renderMerchantEmailLayout). All
 * owner-supplied text is escaped here — the layout does not escape body.
 */

export interface ReceiptLine {
  name: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

export interface ReceiptData {
  kind: "ORDER" | "INVOICE";
  /** Human reference: the order number (ORD-…) or invoice number (INV-…). */
  reference: string;
  date: Date;
  lines: ReceiptLine[];
  total: string;
  amountPaid: string;
  balanceDue: string;
  paymentMethod?: string | null;
  /** Delivery fee included in `total`; rendered as its own line when > 0. */
  deliveryFee?: string | null;
}

export interface BuiltReceiptEmail {
  subject: string;
  html: string;
  text: string;
}

function lineRow(branding: MerchantBranding, line: ReceiptLine): string {
  return `<tr>
    <td style="padding:8px 0;color:#18181b;">${escapeHtml(line.name)} × ${line.quantity}</td>
    <td style="padding:8px 0;text-align:right;color:#18181b;">${formatMoney(line.lineTotal, branding.currency)}</td>
  </tr>`;
}

function totalRow(label: string, amount: string, branding: MerchantBranding, strong = false): string {
  const weight = strong ? "font-weight:700;" : "";
  return `<tr>
    <td style="padding:4px 0;color:#52525b;${weight}">${escapeHtml(label)}</td>
    <td style="padding:4px 0;text-align:right;color:#18181b;${weight}">${formatMoney(amount, branding.currency)}</td>
  </tr>`;
}

export function buildReceiptEmail(
  branding: MerchantBranding,
  receipt: ReceiptData,
): BuiltReceiptEmail {
  const subject = `Receipt ${receipt.reference} — ${branding.storeName}`;

  const itemsTable = `<table style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:14px;">
    ${receipt.lines.map((line) => lineRow(branding, line)).join("")}
  </table>`;

  const hasDelivery =
    receipt.deliveryFee !== undefined &&
    receipt.deliveryFee !== null &&
    Number(receipt.deliveryFee) > 0;

  const totalsTable = `<table style="width:100%;border-collapse:collapse;font-size:14px;">
    ${hasDelivery ? totalRow("Delivery", receipt.deliveryFee!, branding) : ""}
    ${totalRow("Total", receipt.total, branding, true)}
    ${totalRow("Amount paid", receipt.amountPaid, branding)}
    ${totalRow("Balance due", receipt.balanceDue, branding)}
  </table>`;

  const meta = [
    `Date: ${escapeHtml(formatHumanDate(receipt.date))}`,
    receipt.paymentMethod !== undefined && receipt.paymentMethod !== null
      ? `Payment method: ${escapeHtml(receipt.paymentMethod)}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .map((line) => `<p style="margin:0 0 6px;color:#52525b;font-size:14px;">${line}</p>`)
    .join("");

  const html = renderMerchantEmailLayout({
    branding,
    title: escapeHtml(`Receipt ${receipt.reference}`),
    body: [
      `<p style="margin:0 0 12px;color:#52525b;">Thank you for your purchase at ${escapeHtml(branding.storeName)}.</p>`,
      meta,
      `<div style="margin:16px 0 0;">${itemsTable}${totalsTable}</div>`,
    ],
  });

  const textLines = [
    `Receipt ${receipt.reference} — ${branding.storeName}`,
    "",
    `Date: ${formatHumanDate(receipt.date)}`,
    ...(receipt.paymentMethod ? [`Payment method: ${receipt.paymentMethod}`] : []),
    "",
    ...receipt.lines.map(
      (line) =>
        `${line.name} × ${line.quantity} — ${formatMoney(line.lineTotal, branding.currency)}`,
    ),
    "",
    ...(hasDelivery
      ? [`Delivery: ${formatMoney(receipt.deliveryFee!, branding.currency)}`]
      : []),
    `Total: ${formatMoney(receipt.total, branding.currency)}`,
    `Amount paid: ${formatMoney(receipt.amountPaid, branding.currency)}`,
    `Balance due: ${formatMoney(receipt.balanceDue, branding.currency)}`,
    "",
    branding.address,
    branding.phone,
    branding.storefrontUrl,
  ];
  const socials = [branding.socialLinks.instagram, branding.socialLinks.facebook, branding.socialLinks.tiktok]
    .filter((url): url is string => url !== null && url.length > 0);
  if (socials.length > 0) {
    textLines.push(...socials);
  }

  return { subject, html, text: textLines.join("\n") };
}
