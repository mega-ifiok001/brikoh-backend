import { Resend } from "resend";

/** The narrow slice of the Resend SDK every email sender needs. */
export interface ResendEmailClient {
  emails: {
    send(payload: {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
      replyTo?: string;
    }): Promise<unknown>;
  };
}

export function createResendClient(apiKey: string): ResendEmailClient {
  return new Resend(apiKey);
}

/** Sends a fully-built email through the client (subject/html/text). */
export async function sendBuiltEmail(
  client: ResendEmailClient,
  from: string,
  to: string,
  email: { subject: string; html: string; text: string },
  opts?: { replyTo?: string | null },
): Promise<void> {
  await client.emails.send({
    from,
    to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    ...(opts?.replyTo !== undefined && opts.replyTo !== null ? { replyTo: opts.replyTo } : {}),
  });
}
