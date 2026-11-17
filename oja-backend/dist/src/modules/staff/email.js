import { env } from "../../config/env.js";
import { APP_NAME } from "../../lib/email/branding.js";
import { escapeHtml, renderEmailLayout } from "../../lib/email/layout.js";
import { sendBuiltEmail } from "../../lib/email/resend.js";
import { formatHumanDate } from "../../lib/format-date.js";
export { createResendClient } from "../../lib/email/resend.js";
/**
 * Builds the HTML + text invite email. The expiry is rendered through the
 * shared human-date utility (never a raw UTC string). Store names are
 * HTML-escaped — they are owner-supplied free text.
 */
export function buildInviteEmail(data) {
    const acceptLink = `${env.FRONTEND_URL}/#/accept-invite?token=${data.token}`;
    const storeName = escapeHtml(data.storeName);
    const expiry = formatHumanDate(data.expiresAt);
    const subject = `You've been invited to ${data.storeName} on ${APP_NAME}`;
    const text = [
        `You've been invited to ${data.storeName} on ${APP_NAME}.`,
        "",
        `${data.inviterEmail} has invited you to join the team.`,
        "",
        `Accept your invite here: ${acceptLink}`,
        "",
        `This invite expires on ${expiry}.`,
    ].join("\n");
    const html = renderEmailLayout({
        title: `You've been invited to ${storeName} on ${APP_NAME}`,
        body: [
            `<p style="margin:0 0 24px;color:#52525b;">${escapeHtml(data.inviterEmail)} has invited you to join the team.</p>`,
        ],
        cta: { label: "Accept your invite", href: acceptLink },
        footer: [`This invite expires on ${expiry}.`],
    });
    return { subject, html, text };
}
export class ResendInviteSender {
    client;
    fromEmail;
    constructor(client, fromEmail) {
        this.client = client;
        this.fromEmail = fromEmail;
    }
    async sendInviteEmail(data) {
        await sendBuiltEmail(this.client, this.fromEmail, data.to, buildInviteEmail(data));
    }
}
/** Development stub: prints the accept link instead of sending it. */
export class ConsoleInviteSender {
    async sendInviteEmail(data) {
        const email = buildInviteEmail(data);
        console.log(`[invite-email:stub] to ${data.to} — subject "${email.subject}" — link: ${`${env.FRONTEND_URL}/#/accept-invite?token=${data.token}`} (expires ${formatHumanDate(data.expiresAt)})`);
    }
}
//# sourceMappingURL=email.js.map