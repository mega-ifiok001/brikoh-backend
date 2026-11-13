import { env } from "../config/env.js";

const LOCALHOST_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

/**
 * Apex derivation for sibling-subdomain matching. FRONTEND_URL is set to a
 * dashboard subdomain (e.g. https://app.example.com); merchant storefronts
 * live on SIBLING subdomains of the apex (a-merchant-store.example.com), so
 * the last two labels become the apex. This is a pragmatic heuristic — it
 * would collapse for two-label TLDs (example.co.uk) — and deployments
 * should set FRONTEND_URL to the apex domain directly.
 */
function deriveApex(hostname: string): string {
  const labels = hostname.split(".");
  return labels.length > 2 ? labels.slice(-2).join(".") : hostname;
}

export { deriveApex };

/**
 * CORS origin predicate. The exact FRONTEND_URL origin, any subdomain of
 * its apex (dynamically-created merchant storefronts), the extra origins
 * listed in CORS_EXTRA_ORIGINS (exact match OR sibling subdomains of each
 * entry's apex — preview hosts like arena.site rotate their per-build IDs,
 * so a single stale entry must not lock the frontend out), and any
 * localhost / 127.0.0.1 / [::1] dev origin on any port are allowed;
 * every other origin is rejected. Browsers that send no Origin header
 * (same-origin fetches, non-browser clients) are allowed — there are no
 * cookies in this API, so nothing to credential.
 */
export function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (LOCALHOST_ORIGIN_RE.test(origin)) {
    return true;
  }
  if (
    env.CORS_EXTRA_ORIGINS.some((extra) => {
      let extraHost: string;
      try {
        extraHost = new URL(extra).hostname;
      } catch {
        return false;
      }
      return host === extraHost || host.endsWith(`.${deriveApex(extraHost)}`);
    })
  ) {
    return true;
  }
  const frontend = new URL(env.FRONTEND_URL);
  if (host === frontend.hostname) {
    return true;
  }
  return host.endsWith(`.${deriveApex(frontend.hostname)}`);
}
