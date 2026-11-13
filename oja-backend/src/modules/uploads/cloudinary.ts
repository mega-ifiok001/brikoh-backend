import { createHash } from "node:crypto";

/**
 * Cloudinary upload-request signing.
 *
 * A signed upload lets the client POST multipart directly to
 * `https://api.cloudinary.com/v1_1/{cloudName}/image/upload` without the
 * bytes ever transiting our API. The server returns the signing params;
 * the client echoes them back to Cloudinary, which re-computes the
 * signature and rejects any tampering (folder/public_id/timestamp swaps
 * all invalidate it).
 *
 * Cloudinary's signature algorithm (see their "signing requests" docs):
 *   1. sort the upload params by key (alphabetical),
 *   2. join them as `key=value` with `&`,
 *   3. append the API secret,
 *   4. SHA-1 the whole string and hex-encode it.
 * We sign exactly `folder`, `public_id`, and `timestamp` — the params that
 * scope the upload to the tenant and pin it to a fixed object identity.
 * Signing is a pure local computation and never touches the network.
 */

export interface CloudinarySignatureInput {
  /** The destination folder, e.g. `stores/{storeId}`. */
  folder: string;
  /** The object's public id (relative to folder), e.g. `{uuid}-mug.png`. */
  publicId: string;
  /** Unix-seconds timestamp the upload is valid from. */
  timestamp: number;
  /** The Cloudinary API secret. */
  apiSecret: string;
}

export interface CloudinaryUploadParams extends Omit<CloudinarySignatureInput, "apiSecret"> {
  cloudName: string;
  apiKey: string;
  signature: string;
}

export interface CloudinaryUploadParamsInput extends CloudinarySignatureInput {
  cloudName: string;
  apiKey: string;
}

/** SHA-1 over the alphabetically-sorted `key=value` pairs + the API secret. */
export function buildCloudinarySignature(input: CloudinarySignatureInput): string {
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
export function buildCloudinaryUploadParams(
  input: CloudinaryUploadParamsInput,
): CloudinaryUploadParams {
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
