import { Resend } from "resend";
export function createResendClient(apiKey) {
    return new Resend(apiKey);
}
/** Sends a fully-built email through the client (subject/html/text). */
export async function sendBuiltEmail(client, from, to, email, opts) {
    await client.emails.send({
        from,
        to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(opts?.replyTo !== undefined && opts.replyTo !== null ? { replyTo: opts.replyTo } : {}),
    });
}
//# sourceMappingURL=resend.js.map