import { env } from "../../config/env.js";
import { createResendClient, sendBuiltEmail, } from "../../lib/email/resend.js";
/**
 * Strips characters that would break the RFC 5322 From display name or
 * allow header injection (quotes, angle brackets, CR/LF).
 */
export function sanitizeFromName(name) {
    return name
        .replace(/[\r\n]+/g, " ")
        .replace(/["<>]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
}
export class ResendReceiptSender {
    client;
    fromEmail;
    constructor(client, fromEmail) {
        this.client = client;
        this.fromEmail = fromEmail;
    }
    async send(to, email, opts) {
        const displayName = sanitizeFromName(opts.fromName);
        const from = displayName.length > 0 ? `"${displayName}" <${this.fromEmail}>` : this.fromEmail;
        await sendBuiltEmail(this.client, from, to, email, { replyTo: opts.replyTo });
    }
}
/** Development stub: prints the receipt summary instead of sending it. */
export class ConsoleReceiptSender {
    async send(to, email, opts) {
        console.log(`[receipt-email:stub] to ${to} — from "${opts.fromName}" — subject "${email.subject}"`);
    }
}
/**
 * The wired receipt channel. Tests use the console stub (never a real
 * send); development and production use Resend.
 */
export function defaultReceiptSender() {
    if (process.env.NODE_ENV === "test") {
        return new ConsoleReceiptSender();
    }
    return new ResendReceiptSender(createResendClient(env.RESEND_API_KEY), env.RESEND_FROM_EMAIL_RECEIPT);
}
//# sourceMappingURL=sender.js.map