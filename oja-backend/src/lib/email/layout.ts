import { APP_NAME, COMPANY_NAME } from "./branding.js";

/**
 * HTML-escapes owner-supplied free text before it is embedded in an email
 * body (store names, product names, inviter addresses). Never trust raw
 * input in the template.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EmailLayoutOptions {
  /** Card heading. Pass caller-escaped text. */
  title: string;
  /** HTML blocks rendered inside the card, in order. */
  body: string[];
  /** Optional primary call-to-action button. */
  cta?: { label: string; href: string };
  /** Optional small-print lines rendered under the CTA. */
  footer?: string[];
}

/**
 * The shared branded HTML shell for every outbound email: wordmark header,
 * white card with title + body + optional CTA button and small-print
 * footer, company name. Callers escape their own free text (escapeHtml)
 * and render dates through the shared human-date utility.
 */
export function renderEmailLayout(opts: EmailLayoutOptions): string {
  const cta = opts.cta
    ? `<p style="margin:0 0 32px;"><a href="${opts.cta.href}" style="background:#18181b;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">${opts.cta.label}</a></p>`
    : "";
  const footer = (opts.footer ?? [])
    .map(
      (line, index) =>
        `<p style="margin:${index === 0 ? 0 : "12px 0 0"};color:#71717a;font-size:14px;">${line}</p>`,
    )
    .join("");
  return `
<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:system-ui,sans-serif;">
    <div style="max-width:480px;margin:0 auto;">
      <p style="margin:0 0 16px;color:#71717a;font-size:12px;font-weight:600;letter-spacing:0.12em;">${APP_NAME.toUpperCase()}</p>
      <div style="background:#ffffff;border-radius:12px;padding:32px;">
        <h1 style="margin:0 0 16px;font-size:20px;">${opts.title}</h1>
        ${opts.body.join("")}
        ${cta}
        ${footer}
      </div>
      <p style="margin:12px 0 0;color:#a1a1aa;font-size:12px;text-align:center;">${COMPANY_NAME}</p>
    </div>
  </body>
</html>
`;
}
