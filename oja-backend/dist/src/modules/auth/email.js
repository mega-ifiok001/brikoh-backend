import { env } from "../../config/env.js";
import { APP_NAME } from "../../lib/email/branding.js";
import { escapeHtml, renderEmailLayout } from "../../lib/email/layout.js";
import { sendBuiltEmail } from "../../lib/email/resend.js";
import { formatHumanDate } from "../../lib/format-date.js";
export { createResendClient } from "../../lib/email/resend.js";
/**
 * Builds the HTML + text verification email. The expiry is rendered
 * through the shared human-date utility (never a raw UTC string). The
 * token value itself is never HTML-escaped into the page text — it only
 * travels in the href, and generated tokens are URL-safe base64url.
 */
export function buildVerificationEmail(data) {
    const verifyLink = `${env.FRONTEND_URL}/#/verify?token=${data.token}`;
    const expiry = formatHumanDate(data.expiresAt);
    const subject = `Verify your email on ${APP_NAME}`;
    const text = [
        `Welcome to ${APP_NAME} — one more step to go.`,
        "",
        "Verify your email address to finish setting up your store:",
        "",
        `Verify my email: ${verifyLink}`,
        "",
        `This link expires on ${expiry}.`,
        "",
        `If you didn't create an account on ${APP_NAME}, you can ignore this email.`,
    ].join("\n");
    const html = renderEmailLayout({
        title: `Verify your email on ${APP_NAME}`,
        body: [
            `<p style="margin:0 0 24px;color:#52525b;">Welcome to ${APP_NAME}. Verify your email address to finish setting up your store.</p>`,
        ],
        cta: { label: "Verify my email", href: verifyLink },
        footer: [
            `This link expires on ${expiry}.`,
            `If you didn't create an account on ${APP_NAME}, you can ignore this email.`,
        ],
    });
    return { subject, html, text };
}
export class ResendVerificationSender {
    client;
    fromEmail;
    constructor(client, fromEmail) {
        this.client = client;
        this.fromEmail = fromEmail;
    }
    async sendVerificationEmail(data) {
        await sendBuiltEmail(this.client, this.fromEmail, data.to, buildVerificationEmail(data));
    }
}
/** Development stub: prints the verify link instead of sending it. */
export class ConsoleVerificationSender {
    async sendVerificationEmail(data) {
        const email = buildVerificationEmail(data);
        console.log(`[verify-email:stub] to ${data.to} — subject "${email.subject}" — link: ${`${env.FRONTEND_URL}/#/verify?token=${data.token}`} (expires ${formatHumanDate(data.expiresAt)})`);
    }
}
/**
 * Builds the HTML + text welcome email, sent right after the store is
 * created at onboarding. The store name is owner-supplied free text, so
 * it is HTML-escaped in the body (it also appears raw in the text part).
 */
export function buildWelcomeEmail(data) {
    const dashboardUrl = env.FRONTEND_URL;
    const escapedStoreName = escapeHtml(data.storeName);
    const subject = `Welcome to ${APP_NAME} — ${data.storeName} is ready`;
    const text = [
        `Welcome to ${APP_NAME}!`,
        "",
        `Your store, ${data.storeName}, is set up and ready to go.`,
        "",
        `Open your dashboard: ${dashboardUrl}`,
        "",
        "Add products, accept payments, and grow your business from your dashboard.",
    ].join("\n");
    const html = renderEmailLayout({
        title: `Welcome to ${APP_NAME}`,
        body: [
            `<p style="margin:0 0 24px;color:#52525b;">Your store, <strong>${escapedStoreName}</strong>, is set up and ready to go.</p>`,
            `<p style="margin:0 0 24px;color:#52525b;">Add products, accept payments, and grow your business from your dashboard.</p>`,
        ],
        cta: { label: "Open your dashboard", href: dashboardUrl },
        footer: [`You're all set — no further action needed.`],
    });
    return { subject, html, text };
}
export class ResendWelcomeSender {
    client;
    fromEmail;
    constructor(client, fromEmail) {
        this.client = client;
        this.fromEmail = fromEmail;
    }
    async sendWelcomeEmail(data) {
        await sendBuiltEmail(this.client, this.fromEmail, data.to, buildWelcomeEmail(data));
    }
}
/** Development stub: prints the dashboard link instead of sending it. */
export class ConsoleWelcomeSender {
    async sendWelcomeEmail(data) {
        const email = buildWelcomeEmail(data);
        console.log(`[welcome-email:stub] to ${data.to} — subject "${email.subject}" — dashboard: ${env.FRONTEND_URL}`);
    }
}
//# sourceMappingURL=email.js.map