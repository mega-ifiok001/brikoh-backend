import { env } from "../../config/env.js";
import { AppError } from "../../lib/AppError.js";
import { deriveApex } from "../../lib/cors.js";
import { getPrismaClient } from "../../lib/prisma.js";
const DEFAULT_ACCENT = "#18181b";
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function pickAccent(templateSettings, storefrontSettings) {
    const templateAccent = asRecord(templateSettings).accentColor;
    if (typeof templateAccent === "string" && HEX_COLOR_RE.test(templateAccent)) {
        return templateAccent;
    }
    const storefrontAccent = asRecord(storefrontSettings).accentColor;
    if (typeof storefrontAccent === "string" && HEX_COLOR_RE.test(storefrontAccent)) {
        return storefrontAccent;
    }
    return DEFAULT_ACCENT;
}
function pickLogo(templateSettings) {
    const logo = asRecord(templateSettings).logoUrl;
    return typeof logo === "string" && logo.length > 0 ? logo : null;
}
function pickSocialLinks(storefrontSettings) {
    const raw = asRecord(asRecord(storefrontSettings).socialLinks);
    return {
        instagram: typeof raw.instagram === "string" ? raw.instagram : null,
        facebook: typeof raw.facebook === "string" ? raw.facebook : null,
        tiktok: typeof raw.tiktok === "string" ? raw.tiktok : null,
    };
}
function asRecord(value) {
    return typeof value === "object" && value !== null ? value : {};
}
/** The public storefront URL: the custom domain, else subdomain + apex. */
function storefrontUrlFor(customDomain, subdomain) {
    if (customDomain !== null && customDomain.length > 0) {
        return `https://${customDomain}`;
    }
    if (subdomain !== null && subdomain.length > 0) {
        let apex = "brikoh.com";
        try {
            apex = deriveApex(new URL(env.FRONTEND_URL).hostname);
        }
        catch {
            // fall back to the default apex
        }
        return `https://${subdomain}.${apex}`;
    }
    return env.FRONTEND_URL.replace(/\/+$/, "");
}
export async function loadMerchantBranding(storeId) {
    const store = await getPrismaClient().store.findUnique({
        where: { id: storeId },
        select: {
            name: true,
            businessPhone: true,
            location: true,
            currency: true,
            customDomain: true,
            subdomain: true,
            storefrontSettings: true,
            templateSettings: true,
            owner: { select: { account: { select: { email: true } } } },
        },
    });
    if (store === null) {
        throw new AppError(404, "NOT_FOUND", "Store not found");
    }
    return {
        storeName: store.name,
        logoUrl: pickLogo(store.templateSettings),
        accentColor: pickAccent(store.templateSettings, store.storefrontSettings),
        address: store.location,
        phone: store.businessPhone,
        currency: store.currency,
        storefrontUrl: storefrontUrlFor(store.customDomain, store.subdomain),
        socialLinks: pickSocialLinks(store.storefrontSettings),
        replyTo: store.owner?.account.email ?? null,
    };
}
//# sourceMappingURL=branding.js.map