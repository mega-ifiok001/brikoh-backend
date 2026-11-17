import { escapeHtml } from "../../lib/email/layout.js";
import { renderMerchantEmailLayout } from "../../lib/email/merchantLayout.js";
import { formatHumanDate } from "../../lib/format-date.js";
import { formatMoney } from "../../lib/format-currency.js";
function lineRow(branding, line) {
    return `<tr>
    <td style="padding:8px 0;color:#18181b;">${escapeHtml(line.name)} × ${line.quantity}</td>
    <td style="padding:8px 0;text-align:right;color:#18181b;">${formatMoney(line.lineTotal, branding.currency)}</td>
  </tr>`;
}
function totalRow(label, amount, branding, strong = false) {
    const weight = strong ? "font-weight:700;" : "";
    return `<tr>
    <td style="padding:4px 0;color:#52525b;${weight}">${escapeHtml(label)}</td>
    <td style="padding:4px 0;text-align:right;color:#18181b;${weight}">${formatMoney(amount, branding.currency)}</td>
  </tr>`;
}
export function buildReceiptEmail(branding, receipt) {
    const subject = `Receipt ${receipt.reference} — ${branding.storeName}`;
    const itemsTable = `<table style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:14px;">
    ${receipt.lines.map((line) => lineRow(branding, line)).join("")}
  </table>`;
    const hasDelivery = receipt.deliveryFee !== undefined &&
        receipt.deliveryFee !== null &&
        Number(receipt.deliveryFee) > 0;
    const totalsTable = `<table style="width:100%;border-collapse:collapse;font-size:14px;">
    ${hasDelivery ? totalRow("Delivery", receipt.deliveryFee, branding) : ""}
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
        .filter((line) => line !== null)
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
        ...receipt.lines.map((line) => `${line.name} × ${line.quantity} — ${formatMoney(line.lineTotal, branding.currency)}`),
        "",
        ...(hasDelivery
            ? [`Delivery: ${formatMoney(receipt.deliveryFee, branding.currency)}`]
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
        .filter((url) => url !== null && url.length > 0);
    if (socials.length > 0) {
        textLines.push(...socials);
    }
    return { subject, html, text: textLines.join("\n") };
}
//# sourceMappingURL=email.js.map