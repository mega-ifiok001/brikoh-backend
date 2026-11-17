import { APP_NAME } from "./branding.js";
import { escapeHtml } from "./layout.js";
function renderSocialLinks(links, accentColor) {
    const entries = [
        ["Instagram", links.instagram],
        ["Facebook", links.facebook],
        ["TikTok", links.tiktok],
    ];
    const present = entries.filter(([, url]) => url !== null && url.length > 0);
    if (present.length === 0)
        return "";
    const anchors = present
        .map(([label, url]) => `<a href="${escapeHtml(url)}" style="color:${accentColor};text-decoration:none;margin-right:12px;font-weight:600;">${label}</a>`)
        .join("");
    return `<p style="margin:16px 0 0;font-size:14px;">${anchors}</p>`;
}
export function renderMerchantEmailLayout(opts) {
    const { branding } = opts;
    const header = branding.logoUrl !== null
        ? `<img src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(branding.storeName)}" style="max-height:48px;max-width:200px;" />`
        : `<p style="margin:0 0 16px;color:${branding.accentColor};font-size:16px;font-weight:700;">${escapeHtml(branding.storeName)}</p>`;
    const contactLines = [
        escapeHtml(branding.address),
        escapeHtml(branding.phone),
        `<a href="${escapeHtml(branding.storefrontUrl)}" style="color:${branding.accentColor};text-decoration:none;">${escapeHtml(branding.storefrontUrl)}</a>`,
    ];
    const footer = (opts.footer ?? [])
        .map((line, index) => `<p style="margin:${index === 0 ? 0 : "12px 0 0"};color:#71717a;font-size:14px;">${line}</p>`)
        .join("");
    return `
<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:system-ui,sans-serif;">
    <div style="max-width:480px;margin:0 auto;">
      ${header}
      <div style="background:#ffffff;border-radius:12px;padding:32px;">
        <h1 style="margin:0 0 16px;font-size:20px;">${opts.title}</h1>
        ${opts.body.join("")}
        ${footer}
      </div>
      <div style="margin:16px 0 0;padding:0 4px;">
        ${contactLines.map((line) => `<p style="margin:0 0 4px;color:#71717a;font-size:13px;">${line}</p>`).join("")}
        ${renderSocialLinks(branding.socialLinks, branding.accentColor)}
      </div>
      <p style="margin:16px 0 0;color:#a1a1aa;font-size:12px;text-align:center;">Powered by ${APP_NAME}</p>
    </div>
  </body>
</html>
`;
}
//# sourceMappingURL=merchantLayout.js.map