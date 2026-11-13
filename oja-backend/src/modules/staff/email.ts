import { env } from "../../config/env.js";
import { APP_NAME } from "../../lib/email/branding.js";
import { escapeHtml, renderEmailLayout } from "../../lib/email/layout.js";
import { sendBuiltEmail, type ResendEmailClient } from "../../lib/email/resend.js";
import { formatHumanDate } from "../../lib/format-date.js";
import type { InviteEmailData, InviteEmailSender } from "./invite.service.js";

export { createResendClient, type ResendEmailClient } from "../../lib/email/resend.js";

export interface BuiltInviteEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Builds the HTML + text invite email. The expiry is rendered through the
 * shared human-date utility (never a raw UTC string). Store names are
 * HTML-escaped — they are owner-supplied free text.
 */
export function buildInviteEmail(data: InviteEmailData): BuiltInviteEmail {
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

export class ResendInviteSender implements InviteEmailSender {
  constructor(
    private readonly client: ResendEmailClient,
    private readonly fromEmail: string,
  ) {}

  async sendInviteEmail(data: InviteEmailData): Promise<void> {
    await sendBuiltEmail(this.client, this.fromEmail, data.to, buildInviteEmail(data));
  }
}

/** Development stub: prints the accept link instead of sending it. */
export class ConsoleInviteSender implements InviteEmailSender {
  async sendInviteEmail(data: InviteEmailData): Promise<void> {
    const email = buildInviteEmail(data);
    console.log(
      `[invite-email:stub] to ${data.to} — subject "${email.subject}" — link: ${`${env.FRONTEND_URL}/#/accept-invite?token=${data.token}`} (expires ${formatHumanDate(data.expiresAt)})`,
    );
  }
}
