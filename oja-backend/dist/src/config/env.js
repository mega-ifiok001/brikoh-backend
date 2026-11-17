import { z } from "zod";
const durationSchema = z
    .string()
    .regex(/^\d+[smhd]$/, "must be a duration like 30s, 15m, 24h or 7d");
function durationToMs(value) {
    const match = /^(\d+)([smhd])$/.exec(value);
    if (match === null)
        throw new Error(`invalid duration: ${value}`);
    const amount = Number(match[1]);
    const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
    return amount * unitMs;
}
const envSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().max(65535).default(4000),
    // Trust the first reverse-proxy hop (sets req.ip to the real client
    // address, keeping IP-keyed rate limits accurate behind a proxy). Off
    // by default: with no proxy in front, spoofed X-Forwarded-For headers
    // would otherwise defeat the limiter.
    TRUST_PROXY: z
        .enum(["0", "1"])
        .default("0")
        .transform((value) => value === "1"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    TEST_DATABASE_URL: z.string().min(1, "TEST_DATABASE_URL is required"),
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
    JWT_ACCESS_EXPIRES_IN: durationSchema,
    JWT_REFRESH_EXPIRES_IN: durationSchema,
    // Platform-staff (admin) JWT — a SEPARATE secret and lifetime from the
    // merchant JWT. Admin tokens are only issued by the admin login endpoint
    // after a verified TOTP code, and never share claims with store tokens.
    ADMIN_JWT_SECRET: z.string().min(32, "ADMIN_JWT_SECRET must be at least 32 characters"),
    ADMIN_JWT_ACCESS_EXPIRES_IN: durationSchema.default("15m"),
    // Admin refresh token lifetime. Far longer than the access token so admins
    // stay signed in across the short-lived access tokens; still revoked on 2FA
    // rotate/reset. Separate from the merchant JWT_REFRESH_EXPIRES_IN on purpose.
    ADMIN_JWT_REFRESH_EXPIRES_IN: durationSchema.default("7d"),
    // Cloudinary (image CDN + upload). The API secret signs the upload
    // signature returned to the client; the cloud name + API key let the
    // browser POST multipart directly to api.cloudinary.com (no bytes ever
    // transit this API). Dummy values are fine for tests — signing is a
    // pure local computation and never touches the network.
    CLOUDINARY_CLOUD_NAME: z.string().min(1, "CLOUDINARY_CLOUD_NAME is required"),
    CLOUDINARY_API_KEY: z.string().min(1, "CLOUDINARY_API_KEY is required"),
    CLOUDINARY_API_SECRET: z.string().min(1, "CLOUDINARY_API_SECRET is required"),
    // Root folder under which every store's uploads live (default "stores"),
    // so a multi-tenant bucket never mixes tenants. Trailing slashes are
    // stripped; the tenant subfolder is appended at signing time.
    CLOUDINARY_FOLDER_PREFIX: z
        .string()
        .trim()
        .default("stores")
        .transform((value) => value.replace(/\/+$/, "")),
    // The frontend origin, used to build the accept-invite link sent in
    // invite emails. Never points at the API itself.
    FRONTEND_URL: z.string().url("FRONTEND_URL must be a valid URL"),
    // Comma-separated list of additional CORS-allowed origins beyond
    // FRONTEND_URL and its apex subdomains (e.g. preview/staging hosts
    // like https://<id>.arena.site). Each entry allows the exact origin
    // AND any sibling subdomain of its apex, so rotating preview URLs
    // keep working without touching this list. Empty by default.
    CORS_EXTRA_ORIGINS: z
        .string()
        .default("")
        .transform((value) => value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)),
    // How long a staff invite stays valid before expiring (see RULES.md
    // duration format). Dummy in tests; production 7d.
    INVITE_EXPIRES_IN: durationSchema.default("7d"),
    // How often the merchant-alert sweep runs (LOW_STOCK + EXPIRING_SOON).
    // A best-effort in-process timer — see dashboard-notifications.md.
    // Transformed to milliseconds at boot.
    ALERT_SWEEP_INTERVAL_MS: durationSchema.default("6h").transform(durationToMs),
    // How often the bank-transfer expiry sweep runs. Awaiting-payment orders
    // whose "I have paid" claim is older than EXPIRY_MS are flipped back to
    // PENDING so a merchant's queue can't fill with stale/false claims. The
    // cutoff itself is configurable separately (EXPIRY_SWEEP_MAX_AGE_MS).
    EXPIRY_SWEEP_INTERVAL_MS: durationSchema.default("1h").transform(durationToMs),
    // How old an AWAITING_PAYMENT claim must be before the sweep reclaims it.
    EXPIRY_SWEEP_MAX_AGE_MS: durationSchema.default("12h").transform(durationToMs),
    // Platform Paystack keys — the PLATFORM'S account, used to bill merchants
    // for their Brikoh subscriptions. These are distinct from the merchant's
    // own PaymentCredential (which powers the merchant's storefront). The
    // subscription webhook endpoint verifies HMAC against this secret only.
    // Dummies are fine in tests/CI (the provider boundary is mocked); the
    // checkout flow refuses to bill when no plan code is configured.
    PLATFORM_PAYSTACK_SECRET_KEY: z
        .string()
        .regex(/^sk_(test|live)_[A-Za-z0-9]+$/, "PLATFORM_PAYSTACK_SECRET_KEY must be a Paystack sk_ key"),
    PLATFORM_PAYSTACK_PUBLIC_KEY: z
        .string()
        .regex(/^pk_(test|live)_[A-Za-z0-9]+$/, "PLATFORM_PAYSTACK_PUBLIC_KEY must be a Paystack pk_ key"),
    // Grace window a PAST_DUE subscription stays usable for after a failed
    // renewal charge, before enforcement kicks in (default 3 days).
    SUBSCRIPTION_GRACE_PERIOD_MS: durationSchema.default("3d").transform(durationToMs),
    // How often the subscription sweep runs: applies deferred downgrades at
    // cycle end, retries pending upgrade swaps, and flips past-grace
    // PAST_DUE subscriptions to enforced.
    SUBSCRIPTION_SWEEP_INTERVAL_MS: durationSchema.default("1h").transform(durationToMs),
    // Resend transactional email (invite delivery). The API key is only
    // used by the Resend sender; tests mock at the client boundary and
    // never hit the network. Dummy values are fine for local/test runs.
    RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required"),
    RESEND_FROM_EMAIL_ACCOUNT: z.email("RESEND_FROM_EMAIL_ACCOUNT must be a valid email"),
    RESEND_FROM_EMAIL_INVITE: z.email("RESEND_FROM_EMAIL_INVITE must be a valid email"),
    RESEND_FROM_EMAIL_ALERT: z.email("RESEND_FROM_EMAIL_ALERT must be a valid email"),
    // Customer-facing receipt emails. Sent from this platform address with the
    // MERCHANT's store name as the display name and the owner's email as
    // reply-to. Must be on a domain verified in Resend (SPF/DKIM).
    RESEND_FROM_EMAIL_RECEIPT: z.email("RESEND_FROM_EMAIL_RECEIPT must be a valid email"),
    // Google OAuth (Sign in with Google). The backend exchanges the
    // authorization code with the client secret — never exposed to the
    // browser. Tests mock at the Google boundary; dummy values are fine.
    GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
    GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
    // 32-byte master key, 64 hex chars, for AES-256-GCM encryption of
    // merchant payment credentials at rest. Never the JWT secret, and
    // never shared with the frontend.
    PAYMENT_ENCRYPTION_KEY: z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/, "PAYMENT_ENCRYPTION_KEY must be 64 hex chars (32 bytes)"),
});
/**
 * Loads and validates environment variables at boot.
 * Throws immediately if anything is missing or malformed — the process must
 * never start with a partially valid configuration.
 */
export function loadEnv(source = process.env) {
    const parsed = envSchema.safeParse(source);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
            .join("\n");
        throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    return parsed.data;
}
export const env = loadEnv();
/**
 * The redirect URIs the backend accepts for a Google authorization-code
 * exchange: every frontend origin (FRONTEND_URL plus each
 * CORS_EXTRA_ORIGINS entry) with /auth/google/callback appended. This
 * must mirror the Google Cloud Console's "Authorized redirect URIs".
 * The same set is used to validate the redirectUri the frontend sends
 * back with the code, so an unlisted origin cannot complete an exchange.
 */
export function googleRedirectUris(parsed) {
    const origins = [parsed.FRONTEND_URL, ...parsed.CORS_EXTRA_ORIGINS];
    return origins.map((origin) => `${origin.replace(/\/+$/, "")}/auth/google/callback`);
}
//# sourceMappingURL=env.js.map