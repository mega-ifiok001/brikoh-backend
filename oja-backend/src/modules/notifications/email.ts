import { env } from "../../config/env.js";
import { APP_NAME } from "../../lib/email/branding.js";
import { escapeHtml, renderEmailLayout } from "../../lib/email/layout.js";
import {
  createResendClient,
  sendBuiltEmail,
  type ResendEmailClient,
} from "../../lib/email/resend.js";
import { formatHumanDate } from "../../lib/format-date.js";

export interface BuiltAlertEmail {
  subject: string;
  html: string;
  text: string;
}

export interface AlertEmailSender {
  sendAlert(to: string, email: BuiltAlertEmail): Promise<void>;
}

function renderText(lines: string[]): string {
  return lines.join("\n");
}

function renderHtml(title: string, paragraphs: string[], listItems: string[]): string {
  const list =
    listItems.length > 0
      ? `<ul style="margin:0 0 24px;padding-left:20px;color:#52525b;">${listItems
          .map((item) => `<li style="margin-bottom:8px;">${item}</li>`)
          .join("")}</ul>`
      : "";
  return renderEmailLayout({
    title,
    body: [...paragraphs.map((p) => `<p style="margin:0 0 24px;color:#52525b;">${p}</p>`), list],
    footer: [`This is an automated alert from ${APP_NAME}.`],
  });
}

/** One under-stocked branch/product row (per-branch cached stock). */
export interface LowStockAlertItem {
  productName: string;
  branchName: string;
  quantity: number;
  threshold: number | null;
}

/** One product expiring within the 7-day grace window. */
export interface ExpiringSoonAlertItem {
  productName: string;
  expiryDate: Date;
}

/** One money-in event. */
export interface PaymentAlertData {
  /** What happened: checkout order, credit repayment, or invoice payment. */
  label: string;
  amount: string;
  /** Customer / invoice reference rendered in the email body. */
  detail: string;
}

export function buildLowStockAlertEmail(
  storeName: string,
  items: LowStockAlertItem[],
): BuiltAlertEmail {
  const escapedStoreName = escapeHtml(storeName);
  const subject = `Low stock alert — ${storeName}`;
  const text = renderText([
    `Low stock alert for ${storeName}:`,
    "",
    ...items.map(
      (item) =>
        `${item.productName} (${item.branchName}) — ${item.quantity} left${
          item.threshold !== null ? ` (threshold ${item.threshold})` : ""
        }`,
    ),
    "",
    `Restock these items in the ${APP_NAME} dashboard.`,
  ]);
  const html = renderHtml(
    `Low stock alert for ${escapedStoreName}`,
    ["These items are running low:", ""],
    items.map(
      (item) =>
        `<strong>${escapeHtml(item.productName)}</strong> (${escapeHtml(item.branchName)}) — ${
          item.quantity
        } left${item.threshold !== null ? ` (threshold ${item.threshold})` : ""}`,
    ),
  );
  return { subject, html, text };
}

export function buildExpiringSoonAlertEmail(
  storeName: string,
  items: ExpiringSoonAlertItem[],
): BuiltAlertEmail {
  const escapedStoreName = escapeHtml(storeName);
  const subject = `Expiring soon — ${storeName}`;
  const text = renderText([
    `These items expire within the next 7 days at ${storeName}:`,
    "",
    ...items.map((item) => `${item.productName} — expires ${formatHumanDate(item.expiryDate)}`),
    "",
    `Sell or clear these items in the ${APP_NAME} dashboard.`,
  ]);
  const html = renderHtml(
    `Expiring soon at ${escapedStoreName}`,
    ["These items expire within the next 7 days:", ""],
    items.map(
      (item) =>
        `<strong>${escapeHtml(item.productName)}</strong> — expires ${formatHumanDate(
          item.expiryDate,
        )}`,
    ),
  );
  return { subject, html, text };
}

export function buildPaymentAlertEmail(storeName: string, data: PaymentAlertData): BuiltAlertEmail {
  const escapedStoreName = escapeHtml(storeName);
  const subject = `Payment received — ${storeName}`;
  const text = renderText([
    `Payment received at ${storeName}:`,
    "",
    `${data.label}: ${data.amount}`,
    data.detail,
    "",
    "The money is already recorded — no action needed.",
  ]);
  const html = renderHtml(
    `Payment received at ${escapedStoreName}`,
    [
      `<strong>${escapeHtml(data.label)}:</strong> ${escapeHtml(data.amount)}`,
      escapeHtml(data.detail),
      "",
      "The money is already recorded — no action needed.",
    ],
    [],
  );
  return { subject, html, text };
}

export function buildTestAlertEmail(storeName: string): BuiltAlertEmail {
  const escapedStoreName = escapeHtml(storeName);
  const subject = `Test alert — ${storeName}`;
  const text = renderText([
    `This is a test alert from ${storeName}.`,
    "",
    "If you received this email, merchant alerts are wired up correctly.",
  ]);
  const html = renderHtml(
    `Test alert from ${escapedStoreName}`,
    ["If you received this email, merchant alerts are wired up correctly.", ""],
    [],
  );
  return { subject, html, text };
}

export function buildSupportReplyEmail(storeName: string, subject: string): BuiltAlertEmail {
  const escapedStoreName = escapeHtml(storeName);
  return {
    subject: `Support replied — ${storeName}`,
    text: `The ${APP_NAME} support team replied to your ticket: ${subject}.\n\nOpen your dashboard support inbox to read the reply.`,
    html: renderHtml(
      `Support replied to ${escapedStoreName}`,
      [
        "The support team replied to your ticket.",
        `Ticket: <strong>${escapeHtml(subject)}</strong>`,
        "Open your dashboard support inbox to read the reply.",
      ],
      [],
    ),
  };
}

export class ResendAlertSender implements AlertEmailSender {
  constructor(
    private readonly client: ResendEmailClient,
    private readonly fromEmail: string,
  ) {}

  async sendAlert(to: string, email: BuiltAlertEmail): Promise<void> {
    await sendBuiltEmail(this.client, this.fromEmail, to, email);
  }
}

/** Development stub: prints the alert summary instead of sending it. */
export class ConsoleAlertSender implements AlertEmailSender {
  async sendAlert(to: string, email: BuiltAlertEmail): Promise<void> {
    console.log(
      `[alert-email:stub] to ${to} — subject "${email.subject}" — ${email.text.split("\n")[0]}`,
    );
  }
}

/**
 * The wired alert channel. Tests run under NODE_ENV=test and use the
 * console stub (never a real send); development and production use the
 * Resend sender — same rule as the auth verification channel.
 */
export function defaultAlertSender(): AlertEmailSender {
  if (process.env.NODE_ENV === "test") {
    return new ConsoleAlertSender();
  }
  return new ResendAlertSender(createResendClient(env.RESEND_API_KEY), env.RESEND_FROM_EMAIL_ALERT);
}
