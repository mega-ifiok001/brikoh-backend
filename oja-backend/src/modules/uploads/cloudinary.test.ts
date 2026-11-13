import { describe, expect, it } from "vitest";
import {
  buildCloudinarySignature,
  buildCloudinaryUploadParams,
} from "./cloudinary.js";

const API_SECRET = "test-secret-key";

describe("buildCloudinarySignature (unit)", () => {
  it("matches Cloudinary's documented SHA-1 signature for fixed inputs", () => {
    // Golden vector computed against the Cloudinary signing spec:
    // SHA-1(folder=<folder>&public_id=<publicId>&timestamp=<ts><api_secret>),
    // parameters in the documented (alphabetical) order. Independent value
    // computed outside this repo for cross-validation.
    const signature = buildCloudinarySignature({
      folder: "stores/store-aaa",
      publicId: "00000000-0000-4000-8000-000000000000-mugphoto.png",
      timestamp: 1722600000,
      apiSecret: API_SECRET,
    });

    expect(signature).toBe("9d3679e5c3152efb5fc5d1a6e98bf54bb69c1e05");
  });

  it("changes when any signed parameter changes", () => {
    const base = {
      folder: "stores/store-aaa",
      publicId: "00000000-0000-4000-8000-000000000000-mugphoto.png",
      timestamp: 1722600000,
      apiSecret: API_SECRET,
    };
    const original = buildCloudinarySignature(base);

    expect(buildCloudinarySignature({ ...base, folder: "stores/store-bbb" })).not.toBe(original);
    expect(
      buildCloudinarySignature({
        ...base,
        publicId: "11111111-1111-4111-8111-111111111111-coffee.jpg",
      }),
    ).not.toBe(original);
    expect(buildCloudinarySignature({ ...base, timestamp: 1722600001 })).not.toBe(original);
    expect(buildCloudinarySignature({ ...base, apiSecret: "different-secret" })).not.toBe(original);
  });

  it("is deterministic for a fixed clock and inputs", () => {
    const params = {
      folder: "stores/store-aaa",
      publicId: "00000000-0000-4000-8000-000000000000-mugphoto.png",
      timestamp: 1722600000,
      apiSecret: API_SECRET,
    };
    expect(buildCloudinarySignature(params)).toBe(buildCloudinarySignature(params));
  });
});

describe("buildCloudinaryUploadParams (unit)", () => {
  it("returns signing params plus cloud/api metadata for the client", () => {
    const params = buildCloudinaryUploadParams({
      cloudName: "test-cloud",
      apiKey: "test-api-key",
      apiSecret: API_SECRET,
      folder: "stores/store-aaa",
      publicId: "00000000-0000-4000-8000-000000000000-mugphoto.png",
      timestamp: 1722600000,
    });

    expect(params).toEqual({
      cloudName: "test-cloud",
      apiKey: "test-api-key",
      timestamp: 1722600000,
      folder: "stores/store-aaa",
      publicId: "00000000-0000-4000-8000-000000000000-mugphoto.png",
      signature: "9d3679e5c3152efb5fc5d1a6e98bf54bb69c1e05",
    });
  });

  it("keeps the upload locked to the folder: changing folder invalidates the signature", () => {
    const base = {
      cloudName: "test-cloud",
      apiKey: "test-api-key",
      apiSecret: API_SECRET,
      folder: "stores/store-aaa",
      publicId: "00000000-0000-4000-8000-000000000000-mugphoto.png",
      timestamp: 1722600000,
    };

    const params = buildCloudinaryUploadParams(base);
    const forged = buildCloudinaryUploadParams({ ...base, folder: "stores/store-bbb" });

    // A client swapping the folder gets a mismatched signature — the server's
    // signature no longer covers the claimed folder, so Cloudinary rejects it.
    expect(forged.folder).not.toBe(params.folder);
    expect(forged.signature).not.toBe(params.signature);
  });
});
