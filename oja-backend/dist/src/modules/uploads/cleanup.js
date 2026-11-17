/**
 * Best-effort image cleanup for product mutations.
 *
 * When a product's images change (PATCH) or the product is soft-deleted
 * (DELETE), the removed Cloudinary assets should not linger in the CDN.
 * This helper extracts the tenant-scoped public ids from the affected
 * URLs and destroys them via the Admin API.
 *
 * Safety properties:
 *  - Only URLs that resolve to OUR cloud name AND live under
 *    `{prefix}/{storeId}` are ever destroyed (see
 *    extractCloudinaryPublicId) — a merchant's product rows can never
 *    trigger deletion of another merchant's or an external asset.
 *  - The destroy is fire-and-forget and fully swallowed: a failed delete
 *    (or an unreachable Cloudinary) must never fail a product write. The
 *    product row is already committed; cleanup is a best-effort sweep.
 */
import { env } from "../../config/env.js";
import { cloudinaryAdmin, extractCloudinaryPublicId } from "./cloudinaryAdmin.js";
/**
 * Schedules (fire-and-forget) destruction of every Cloudinary asset among
 * `urls` that belongs to `storeId`'s folder. Returns immediately.
 */
export function scheduleProductImageCleanup(storeId, urls) {
    const folderPrefix = `${env.CLOUDINARY_FOLDER_PREFIX}/${storeId}`;
    const publicIds = [];
    for (const url of urls) {
        const parsed = extractCloudinaryPublicId(url, env.CLOUDINARY_CLOUD_NAME, env.CLOUDINARY_FOLDER_PREFIX);
        if (parsed === null)
            continue;
        if (parsed.folder !== folderPrefix && !parsed.folder.startsWith(`${folderPrefix}/`))
            continue;
        publicIds.push(`${parsed.folder}/${parsed.publicId}`);
    }
    if (publicIds.length === 0)
        return;
    void cloudinaryAdmin.destroyImages(publicIds).catch(() => {
        // Best-effort by design: a failed cleanup never surfaces to the
        // product write that triggered it.
    });
}
//# sourceMappingURL=cleanup.js.map