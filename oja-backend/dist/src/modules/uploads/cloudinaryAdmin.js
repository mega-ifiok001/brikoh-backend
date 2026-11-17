/**
 * Cloudinary Admin API client — the server-side destroy path.
 *
 * Uploads are signed direct uploads (no bytes through this API), but
 * deleting an asset requires the Admin API with the API secret. This
 * module talks to Cloudinary's Admin REST API directly with an
 * injectable `fetchFn` (the paystack-provider pattern) so tests exercise
 * the full HTTP contract with a stub and never touch the network.
 *
 * The only operation products need today is bulk destroy of images.
 */
const CLOUDINARY_ADMIN_BASE = "https://api.cloudinary.com";
export class CloudinaryAdminError extends Error {
    statusCode;
    code;
    constructor(statusCode, code, message) {
        super(message);
        this.name = "CloudinaryAdminError";
        this.statusCode = statusCode;
        this.code = code;
    }
}
/**
 * Parses the public id out of a Cloudinary upload URL so server code can
 * destroy the asset it previously signed. Only URLs for OUR cloud name
 * and under the tenant folder prefix are recognized — anything else
 * (external CDN, another tenant, another asset type) returns null and is
 * never handed to the delete API. This is the tenant-isolation guard for
 * auto-cleanup: a merchant can never trigger deletion of another
 * merchant's asset through their own product rows.
 *
 * Handles both plain URLs and the transformation/version segments
 * Cloudinary inserts (`f_auto,q_auto`, `v<unix>`), e.g.
 *   https://res.cloudinary.com/{cloud}/image/upload/{folder}/{publicId}
 *   https://res.cloudinary.com/{cloud}/image/upload/f_auto,q_auto/v123/{folder}/{publicId}
 */
export function extractCloudinaryPublicId(url, cloudName, folderPrefix) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return null;
    }
    if (parsed.hostname !== "res.cloudinary.com")
        return null;
    const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
    if (segments[0] !== cloudName)
        return null;
    if (segments[1] !== "image")
        return null;
    if (segments[2] !== "upload")
        return null;
    // Everything between /upload/ and the final public id are transform
    // and version segments (`f_auto,q_auto`, `v<unix>`). The tenant folder
    // is the run of segments that starts exactly at the folder-prefix
    // segment (the root folder) and extends to the public id. Searching
    // for the exact prefix segment skips transforms/versions, which never
    // equal the prefix, and rejects folders that merely share the name
    // (e.g. prefix "stores" vs an unrelated "avatars/..." folder).
    const publicId = segments[segments.length - 1];
    if (publicId === undefined)
        return null;
    let prefixIndex = -1;
    for (let i = 3; i < segments.length - 1; i += 1) {
        if (segments[i] === folderPrefix) {
            prefixIndex = i;
            break;
        }
    }
    if (prefixIndex === -1)
        return null;
    const folder = segments.slice(prefixIndex, segments.length - 1).join("/");
    return { folder, publicId };
}
/**
 * Creates a Cloudinary Admin client. The only operation products need is
 * bulk destroy: `DELETE /v1_1/{cloud}/resources/image/upload` with the
 * `public_ids` payload, authenticated with HTTP Basic (api_key:api_secret).
 */
export function createCloudinaryAdmin(options) {
    const { cloudName, apiKey, apiSecret } = options;
    const fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
    const apiBase = `${CLOUDINARY_ADMIN_BASE}/v1_1/${encodeURIComponent(cloudName)}`;
    /**
     * Deletes up to 1000 images in one Admin API call. The `deleted` map is
     * returned best-effort — Cloudinary omits ids it has no record of.
     */
    async function destroyImages(publicIds) {
        if (publicIds.length === 0) {
            throw new CloudinaryAdminError(400, "EMPTY_PUBLIC_IDS", "at least one public id is required");
        }
        let response;
        try {
            response = await fetchFn(`${apiBase}/resources/image/upload`, {
                method: "DELETE",
                headers: {
                    Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ public_ids: publicIds }),
            });
        }
        catch {
            // Static message on purpose: the underlying error can echo secrets
            // (URLs, headers) and would be logged by the global error handler.
            throw new CloudinaryAdminError(0, "CLOUDINARY_UNREACHABLE", "cloudinary admin is unreachable");
        }
        const body = (await response.json().catch(() => ({})));
        if (!response.ok) {
            throw new CloudinaryAdminError(response.status, "CLOUDINARY_REJECTED", `cloudinary rejected the destroy request (HTTP ${response.status})`);
        }
        return { deleted: body.deleted };
    }
    return { destroyImages };
}
/** The shared admin client, wired from env at module load. */
import { env } from "../../config/env.js";
export const cloudinaryAdmin = createCloudinaryAdmin({
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
});
//# sourceMappingURL=cloudinaryAdmin.js.map