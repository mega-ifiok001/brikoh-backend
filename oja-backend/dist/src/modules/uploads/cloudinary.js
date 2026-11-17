import { createHash } from "node:crypto";
/** SHA-1 over the alphabetically-sorted `key=value` pairs + the API secret. */
export function buildCloudinarySignature(input) {
    const { folder, publicId, timestamp, apiSecret } = input;
    const canonical = [
        ["folder", folder],
        ["public_id", publicId],
        ["timestamp", String(timestamp)],
    ]
        .map((entry) => `${entry[0]}=${entry[1]}`)
        .sort()
        .join("&");
    return createHash("sha1").update(`${canonical}${apiSecret}`, "utf8").digest("hex");
}
/**
 * The full set of params the client needs to perform a signed upload:
 * cloud/api metadata plus the signature over `folder`, `public_id`, and
 * `timestamp`. The API secret is never included in the output.
 */
export function buildCloudinaryUploadParams(input) {
    const { cloudName, apiKey, folder, publicId, timestamp, apiSecret } = input;
    return {
        cloudName,
        apiKey,
        timestamp,
        folder,
        publicId,
        signature: buildCloudinarySignature({ folder, publicId, timestamp, apiSecret }),
    };
}
//# sourceMappingURL=cloudinary.js.map