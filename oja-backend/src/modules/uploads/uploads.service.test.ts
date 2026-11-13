import { describe, expect, it } from "vitest";
import { env } from "../../config/env.js";
import { buildObjectKey, presignProductImage, sanitizeFileName } from "./service.js";
describe("sanitizeFileName (unit)", () => {
  it("keeps safe characters and strips everything else", () => {
    expect(sanitizeFileName("my coffee!.png")).toBe("mycoffee.png");
    expect(sanitizeFileName("My Image (1).JPG")).toBe("MyImage1.JPG");
  });

  it("never lets path separators escape the key prefix", () => {
    // Basename semantics: only the last path segment survives, so a
    // traversal attempt resolves inside the server-chosen directory.
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..\\..\\payload.sh")).toBe("payload.sh");
    expect(sanitizeFileName("a/b/c/d.png")).toBe("d.png");
  });

  it("truncates to 100 characters and falls back for empty results", () => {
    expect(sanitizeFileName("x".repeat(250))).toHaveLength(100);
    expect(sanitizeFileName("../../")).toBe("image");
    expect(sanitizeFileName("")).toBe("image");
  });
});

describe("buildObjectKey (unit)", () => {
  it("is fully server-generated: tenant prefix + uuid + sanitized name", () => {
    const key = buildObjectKey("store-aaa", "../evil.png", "00000000-0000-4000-8000-000000000000");
    expect(key).toBe("stores/store-aaa/00000000-0000-4000-8000-000000000000-evil.png");
  });

  it("scopes to the passed storeId — a cross-store key is structurally impossible", () => {
    const a = buildObjectKey("store-aaa", "photo.png", "11111111-1111-4111-8111-111111111111");
    const b = buildObjectKey("store-bbb", "photo.png", "22222222-2222-4222-8222-222222222222");
    expect(a.startsWith("stores/store-aaa/")).toBe(true);
    expect(b.startsWith("stores/store-bbb/")).toBe(true);
    expect(a.includes("store-bbb")).toBe(false);
    expect(b.includes("store-aaa")).toBe(false);
  });
});

describe("presignProductImage (unit)", () => {
  it("returns Cloudinary signing params, the public URL, and the key", async () => {
    const result = await presignProductImage({
      storeId: "store-aaa",
      fileName: "mug photo.png",
      contentType: "image/png",
      declaredSizeBytes: 1_000_000,
    });

    expect(result.key).toMatch(/^stores\/store-aaa\/[0-9a-f-]{36}-mugphoto\.png$/);
    expect(result.expiresInSeconds).toBe(300);
    expect(result.cloudName).toBe(env.CLOUDINARY_CLOUD_NAME);
    expect(result.apiKey).toBe(env.CLOUDINARY_API_KEY);
    expect(result.folder).toBe(`${env.CLOUDINARY_FOLDER_PREFIX}/store-aaa`);
    expect(result.publicId).toMatch(/^[0-9a-f-]{36}-mugphoto\.png$/);
    expect(result.timestamp).toEqual(expect.any(Number));
    expect(result.signature).toMatch(/^[a-f0-9]{40}$/);
    expect(result.publicUrl).toBe(
      `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/${result.folder}/${result.publicId}`,
    );
  });

  it("signs the exact folder/public_id/timestamp the client must upload", async () => {
    const result = await presignProductImage({
      storeId: "store-aaa",
      fileName: "mug photo.png",
      contentType: "image/png",
      declaredSizeBytes: 1_000_000,
    });

    // The client is locked to the returned folder + public_id: any change to
    // either invalidates the signature. Verify the signature is a SHA-1 over
    // those exact values so the server's guarantee is structural.
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha1")
      .update(
        `folder=${result.folder}&public_id=${result.publicId}&timestamp=${result.timestamp}${env.CLOUDINARY_API_SECRET}`,
      )
      .digest("hex");
    expect(result.signature).toBe(expected);
  });

  it.each([
    ["application/pdf", "pdf outside the allowlist"],
    ["image/gif", "gif outside the allowlist"],
    ["image/jpeg; charset=utf-8", "parameterized content type"],
  ])("rejects %s (%s)", async (contentType) => {
    await expect(
      presignProductImage({
        storeId: "store-aaa",
        fileName: "a.png",
        contentType,
        declaredSizeBytes: 1_000,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "UNSUPPORTED_CONTENT_TYPE" });
  });

  it("rejects declared sizes above the 10 MB cap", async () => {
    await expect(
      presignProductImage({
        storeId: "store-aaa",
        fileName: "a.png",
        contentType: "image/png",
        declaredSizeBytes: 10_485_761,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "FILE_TOO_LARGE" });
  });

  it("accepts exactly the 10 MB boundary", async () => {
    const result = await presignProductImage({
      storeId: "store-aaa",
      fileName: "a.png",
      contentType: "image/jpeg",
      declaredSizeBytes: 10_485_760,
    });
    expect(result.signature).toMatch(/^[a-f0-9]{40}$/);
  });

  it.each([
    [{ fileName: "", contentType: "image/png", declaredSizeBytes: 1 }, "empty filename"],
    [
      { fileName: "x".repeat(101), contentType: "image/png", declaredSizeBytes: 1 },
      "overlong filename",
    ],
    [{ fileName: "a.png", contentType: "image/png", declaredSizeBytes: 0 }, "zero size"],
    [{ fileName: "a.png", contentType: "image/png", declaredSizeBytes: -5 }, "negative size"],
    [{ fileName: "a.png", contentType: "image/png", declaredSizeBytes: 5.5 }, "fractional size"],
  ])("rejects malformed input %s", async (input) => {
    await expect(presignProductImage({ storeId: "store-aaa", ...input })).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });
});
