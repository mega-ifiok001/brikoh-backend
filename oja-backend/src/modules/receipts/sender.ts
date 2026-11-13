import { env } from "../../config/env.js";
import {
  createResendClient,
  sendBuiltEmail,
  type ResendEmailClient,
} from "../../lib/email/resend.js";
import type { BuiltReceiptEmail } from "./email.js";

/**
 * Customer receipt sender. Unlike the platform alert sender, receipts go
 * out with the MERCHANT's store name as the From display name and the
 * owner's email as reply-to; the address itself is the platform's
 * verified receipt address (per-merchant sending domains are out of scope).
 */
export interface ReceiptSendOptions {
  fromName: string;
  replyTo: string | null;
}

export interface ReceiptEmailSender {
  send(to: string, email: BuiltReceiptEmail, opts: ReceiptSendOptions): Promise<void>;
}

/**
 * Strips characters that would break the RFC 5322 From display name or
 * allow header injection (quotes, angle brackets, CR/LF).
 */
export function sanitizeFromName(name: string): string {
  return name
    .replace(/[\r\n]+/g, " ")
    .replace(/["<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export class ResendReceiptSender implements ReceiptEmailSender {
  constructor(
    private readonly client: ResendEmailClient,
    private readonly fromEmail: string,
  ) {}

  async send(to: string, email: BuiltReceiptEmail, opts: ReceiptSendOptions): Promise<void> {
    const displayName = sanitizeFromName(opts.fromName);
    const from = displayName.length > 0 ? `"${displayName}" <${this.fromEmail}>` : this.fromEmail;
    await sendBuiltEmail(this.client, from, to, email, { replyTo: opts.replyTo });
  }
}

/** Development stub: prints the receipt summary instead of sending it. */
export class ConsoleReceiptSender implements ReceiptEmailSender {
  async send(to: string, email: BuiltReceiptEmail, opts: ReceiptSendOptions): Promise<void> {
    console.log(
      `[receipt-email:stub] to ${to} — from "${opts.fromName}" — subject "${email.subject}"`,
    );
  }
}

/**
 * The wired receipt channel. Tests use the console stub (never a real
 * send); development and production use Resend.
 */
export function defaultReceiptSender(): ReceiptEmailSender {
  if (process.env.NODE_ENV === "test") {
    return new ConsoleReceiptSender();
  }
  return new ResendReceiptSender(
    createResendClient(env.RESEND_API_KEY),
    env.RESEND_FROM_EMAIL_RECEIPT,
  );
}
