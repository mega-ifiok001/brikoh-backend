import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/AppError.js";
import { validateOrThrow } from "../../lib/validate.js";
import { buildCloudinaryUploadParams } from "./cloudinary.js";
/**
 * Signed direct-upload service for product images.
 *
 * The object identity is fully server-generated: `stores/{storeId}` folder,
 * `{uuid}-{sanitizedName}` public id. The client chooses only a display
 * name, and sanitizeFileName strips every path separator and non-safe
 * character, so a request can never address another store's prefix or
 * escape the folder — this is tested structurally in uploads.service.test.ts.
 *
 * The size cap (10 MB) applies to the client-DECLARED size: Cloudinary's
 * signed upload cannot carry a server-enforced Content-Length condition,
 * so this is the guarantee at signing time. Cloudinary-side enforcement is
 * a later phase.
 */
export const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const PRESIGNED_URL_EXPIRES_SECONDS = 300;
const presignSchema = z.object({
    fileName: z
        .string()
        .trim()
        .min(1, "File name is required")
        .max(100, "fileName must be at most 100 characters"),
    contentType: z.string().min(1, "File type is required"),
    declaredSizeBytes: z
        .number({ error: "declaredSizeBytes must be a number" })
        .int("declaredSizeBytes must be an integer")
        .min(1, "declaredSizeBytes must be at least 1"),
});
/**
 * Reduces a client-supplied name to safe characters: everything outside
 * [A-Za-z0-9._-] is dropped, path separators can never survive (the
 * basename is taken first), and leading dots are removed. Empty results
 * fall back to "image" so the key never ends in a dangling dash.
 */
export function sanitizeFileName(raw) {
    const basename = raw.split(/[\\/]/).pop() ?? "";
    const cleaned = basename
        .replace(/[^A-Za-z0-9._-]/g, "")
        .replace(/^\.+/, "")
        .slice(0, 100);
    return cleaned === "" ? "image" : cleaned;
}
/** Server-generated key; uuid is injectable for deterministic tests. */
export function buildObjectKey(storeId, fileName, uuid = randomUUID()) {
    return `stores/${storeId}/${uuid}-${sanitizeFileName(fileName)}`;
}
export async function presignProductImage(input) {
    // storeId is deliberately NOT part of the validated schema: it comes
    // exclusively from the authenticated tenant context (req.tenant) and
    // can never be influenced by the client request body.
    const { storeId } = input;
    const { fileName, contentType, declaredSizeBytes } = validateOrThrow(presignSchema, input);
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
        throw new AppError(400, "UNSUPPORTED_CONTENT_TYPE", `contentType must be one of: ${ALLOWED_CONTENT_TYPES.join(", ")}`);
    }
    if (declaredSizeBytes > MAX_FILE_SIZE_BYTES) {
        throw new AppError(400, "FILE_TOO_LARGE", `declaredSizeBytes exceeds the maximum of ${MAX_FILE_SIZE_BYTES} (10 MB)`);
    }
    const folder = `${env.CLOUDINARY_FOLDER_PREFIX}/${storeId}`;
    const key = buildObjectKey(storeId, fileName);
    const publicId = key.split("/").pop() ?? key;
    const timestamp = Math.floor(Date.now() / 1000);
    const params = buildCloudinaryUploadParams({
        cloudName: env.CLOUDINARY_CLOUD_NAME,
        apiKey: env.CLOUDINARY_API_KEY,
        apiSecret: env.CLOUDINARY_API_SECRET,
        folder,
        publicId,
        timestamp,
    });
    return {
        ...params,
        publicUrl: `https://res.cloudinary.com/${params.cloudName}/image/upload/${params.folder}/${params.publicId}`,
        key,
        expiresInSeconds: PRESIGNED_URL_EXPIRES_SECONDS,
    };
}
//# sourceMappingURL=service.js.map