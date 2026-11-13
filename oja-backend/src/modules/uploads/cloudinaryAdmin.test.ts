import { describe, expect, it, vi } from "vitest";
import { createCloudinaryAdmin, extractCloudinaryPublicId } from "./cloudinaryAdmin.js";

const CLOUD_NAME = "test-cloud";
const FOLDER_PREFIX = "stores";

describe("extractCloudinaryPublicId (unit)", () => {
  it("parses the public id from a plain res.cloudinary.com upload URL", () => {
    const url = "https://res.cloudinary.com/test-cloud/image/upload/stores/store-aaa/uuid-mug.png";
    expect(extractCloudinaryPublicId(url, CLOUD_NAME, FOLDER_PREFIX)).toEqual({
      folder: "stores/store-aaa",
      publicId: "uuid-mug.png",
    });
  });

  it("ignores transformation and version segments", () => {
    const url =
      "https://res.cloudinary.com/test-cloud/image/upload/f_auto,q_auto/v1722600000/stores/store-aaa/uuid-mug.png";
    expect(extractCloudinaryPublicId(url, CLOUD_NAME, FOLDER_PREFIX)).toEqual({
      folder: "stores/store-aaa",
      publicId: "uuid-mug.png",
    });
  });

  it("returns null for URLs not on our cloud name", () => {
    const url = "https://res.cloudinary.com/other-cloud/image/upload/stores/store-aaa/uuid-mug.png";
    expect(extractCloudinaryPublicId(url, CLOUD_NAME, FOLDER_PREFIX)).toBeNull();
  });

  it("returns null for URLs outside the tenant folder prefix", () => {
    const url = "https://res.cloudinary.com/test-cloud/image/upload/avatars/user-1/uuid.png";
    expect(extractCloudinaryPublicId(url, CLOUD_NAME, FOLDER_PREFIX)).toBeNull();
  });

  it("returns null for non-Cloudinary URLs (external images)", () => {
    expect(extractCloudinaryPublicId("https://cdn.shopify.com/img.png", CLOUD_NAME, FOLDER_PREFIX)).toBeNull();
    expect(extractCloudinaryPublicId("https://example.com/stores/store-aaa/uuid.png", CLOUD_NAME, FOLDER_PREFIX)).toBeNull();
  });

  it("returns null when the upload path is missing (video/raw fetch)", () => {
    const url = "https://res.cloudinary.com/test-cloud/video/upload/stores/store-aaa/uuid.mp4";
    expect(extractCloudinaryPublicId(url, CLOUD_NAME, FOLDER_PREFIX)).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(extractCloudinaryPublicId("not-a-url", CLOUD_NAME, FOLDER_PREFIX)).toBeNull();
    expect(extractCloudinaryPublicId("", CLOUD_NAME, FOLDER_PREFIX)).toBeNull();
    expect(extractCloudinaryPublicId("https://res.cloudinary.com/test-cloud", CLOUD_NAME, FOLDER_PREFIX)).toBeNull();
  });
});

describe("createCloudinaryAdmin.destroyImages (unit)", () => {
  function buildFetch(response: Partial<Response>) {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({}),
      ...response,
    } as unknown as Response);
  }

  it("calls the Admin API with Basic auth and the public ids", async () => {
    const fetchFn = buildFetch({});
    const admin = createCloudinaryAdmin({
      cloudName: CLOUD_NAME,
      apiKey: "api-key",
      apiSecret: "api-secret",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await admin.destroyImages(["stores/store-aaa/uuid-1.png", "stores/store-aaa/uuid-2.png"]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.cloudinary.com/v1_1/test-cloud/resources/image/upload");
    expect(init.method).toBe("DELETE");
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: `Basic ${Buffer.from("api-key:api-secret").toString("base64")}`,
        "Content-Type": "application/json",
      }),
    );
    expect(JSON.parse(init.body as string)).toEqual({
      public_ids: ["stores/store-aaa/uuid-1.png", "stores/store-aaa/uuid-2.png"],
    });
  });

  it("returns the per-id result when Cloudinary reports it", async () => {
    const fetchFn = buildFetch({
      json: vi.fn().mockResolvedValue({
        deleted: {
          "stores/store-aaa/uuid-1.png": "deleted",
          "stores/store-aaa/uuid-2.png": "not_found",
        },
      }),
    });
    const admin = createCloudinaryAdmin({
      cloudName: CLOUD_NAME,
      apiKey: "api-key",
      apiSecret: "api-secret",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const result = await admin.destroyImages([
      "stores/store-aaa/uuid-1.png",
      "stores/store-aaa/uuid-2.png",
    ]);

    expect(result.deleted).toEqual({
      "stores/store-aaa/uuid-1.png": "deleted",
      "stores/store-aaa/uuid-2.png": "not_found",
    });
  });

  it("throws a CloudinaryAdminError on non-2xx with the static message", async () => {
    const fetchFn = buildFetch({ ok: false, status: 401, json: vi.fn().mockResolvedValue({ error: { message: "bad credentials" } }) });
    const admin = createCloudinaryAdmin({
      cloudName: CLOUD_NAME,
      apiKey: "api-key",
      apiSecret: "wrong-secret",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(admin.destroyImages(["stores/store-aaa/uuid-1.png"])).rejects.toThrow(
      /cloudinary rejected the destroy request \(HTTP 401\)/,
    );
  });

  it("maps network failures to a static unreachable message", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const admin = createCloudinaryAdmin({
      cloudName: CLOUD_NAME,
      apiKey: "api-key",
      apiSecret: "api-secret",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(admin.destroyImages(["stores/store-aaa/uuid-1.png"])).rejects.toThrow(
      /cloudinary admin is unreachable/,
    );
  });

  it("surfaces non-JSON responses without crashing", async () => {
    const fetchFn = buildFetch({ json: vi.fn().mockRejectedValue(new Error("not json")) });
    const admin = createCloudinaryAdmin({
      cloudName: CLOUD_NAME,
      apiKey: "api-key",
      apiSecret: "api-secret",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const result = await admin.destroyImages(["stores/store-aaa/uuid-1.png"]);
    expect(result.deleted).toBeUndefined();
  });

  it("rejects an empty public-ids list", async () => {
    const admin = createCloudinaryAdmin({
      cloudName: CLOUD_NAME,
      apiKey: "api-key",
      apiSecret: "api-secret",
      fetchFn: buildFetch({}) as unknown as typeof fetch,
    });

    await expect(admin.destroyImages([])).rejects.toThrow(/at least one public id/);
  });
});
