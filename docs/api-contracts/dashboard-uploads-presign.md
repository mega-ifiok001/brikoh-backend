# POST /api/dashboard/uploads/presign-product-image

Route group: dashboard
Auth: bearer + store
Rate-limited: no

Returns a short-lived **signed Cloudinary upload** for direct upload of a
product image. The client POSTs the file multipart straight to
`https://api.cloudinary.com/v1_1/{cloudName}/image/upload` using the signing
params in the response (no bytes ever transit this API), then persists the
final public URL by calling `PATCH /api/dashboard/products/:productId` with
the URL in `images`.

## Security model

- The object identity is **always server-generated**:
  `folder = {CLOUDINARY_FOLDER_PREFIX}/{storeId}` and
  `public_id = {uuid}-{sanitizedFileName}`. The client chooses only a display
  name; path separators and anything that could escape the folder are
  stripped. A request can never address another store's folder, and testing
  this structurally is part of the backend suite.
- The upload is **signature-locked**: Cloudinary re-computes
  `SHA1(folder=…&public_id=…&timestamp=… + apiSecret)` and rejects any client
  that swaps the folder, public_id, or timestamp — the signature covers
  exactly those three params.
- The timestamp is the current Unix time (seconds); it is echoed back so the
  client cannot reuse a stale signature. The upload is scoped to exactly one
  multipart `POST` of one object identity.
- The declared content-type is validated server-side against the allowlist
  (`image/jpeg`, `image/png`, `image/webp`). Cloudinary enforces its own
  file-type rules at upload time.
- The size cap applies to the client-declared value: requests declaring
  more than 10 MB are refused. Cloudinary-side enforcement (upload limits /
  post-upload verification) is planned for a later phase.
- Requires the `products.manage` permission.

## Request

Body:

```json
{
  "fileName": "string — 1-100 chars; basename only, sanitized server-side",
  "contentType": "image/jpeg | image/png | image/webp",
  "declaredSizeBytes": "number — integer, 1 - 10_485_760 (10 MB)"
}
```

## Success response

Status: `200`

```json
{
  "cloudName": "string — CLOUDINARY_CLOUD_NAME, prefix for the upload endpoint",
  "apiKey": "string — CLOUDINARY_API_KEY",
  "timestamp": "number — Unix seconds; the signature is valid from this time",
  "signature": "string — SHA-1 hex over folder/public_id/timestamp + apiSecret",
  "folder": "string — {CLOUDINARY_FOLDER_PREFIX}/{storeId}",
  "publicId": "string — {uuid}-{sanitizedFileName}",
  "publicUrl": "string — https://res.cloudinary.com/{cloudName}/image/upload/{folder}/{publicId}; usable as a Product.images value after upload",
  "key": "string — {folder}/{publicId}",
  "expiresInSeconds": 300
}
```

The client uploads the file with a `multipart/form-data` `POST` to:

```
https://api.cloudinary.com/v1_1/{cloudName}/image/upload
```

with fields `api_key`, `timestamp`, `signature`, `folder`, `public_id`, and
`file` (the image bytes).

## Destroy / cleanup

There is no public delete endpoint for uploaded images — cleanup happens
through the products API:

- `PATCH /api/dashboard/products/:productId` — Cloudinary assets removed from
  `images`/`coverImageUrl` are automatically destroyed.
- `DELETE /api/dashboard/products/:productId` — all of the product's Cloudinary
  assets are destroyed alongside the soft delete.

Cleanup is **best-effort and fire-and-forget**: a failed destroy (or an
unreachable Cloudinary) never fails the product write — the row is already
committed and the response is unaffected. It is also **tenant-isolated**: only
URLs matching `res.cloudinary.com/{cloud}/{CLOUDINARY_FOLDER_PREFIX}/{storeId}`
are ever destroyed. External or other-tenant URLs are ignored, so a merchant's
product rows can never trigger deletion of another tenant's or a foreign asset.

The Admin API destroy call (`DELETE /v1_1/{cloud}/resources/image/upload`) is
an internal implementation detail, not part of the client contract.

## Error responses

| Status | Code                        | Condition                              |
| ------ | --------------------------- | -------------------------------------- |
| `400`  | `VALIDATION_ERROR`          | Malformed body                         |
| `400`  | `UNSUPPORTED_CONTENT_TYPE`  | contentType outside the allowlist      |
| `400`  | `FILE_TOO_LARGE`            | declaredSizeBytes > 10 MB              |
| `401`  | `UNAUTHORIZED`              | Missing/invalid token, or no store association |
| `403`  | `INSUFFICIENT_PERMISSIONS`  | Lacks `products.manage`                |

Cloudinary configuration is validated at boot by `env.ts` — a missing or
malformed `CLOUDINARY_*` variable prevents the server from starting, so there
is no runtime error for missing config. Any unexpected failure during signing
surfaces as the standard `500 INTERNAL_SERVER_ERROR`.

Uniform error body shape (see `docs/api-contracts/README.md`).
