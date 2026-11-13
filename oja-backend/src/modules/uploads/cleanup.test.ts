import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";

const adminMocks = vi.hoisted(() => ({ destroyImages: vi.fn() }));
vi.mock("./cloudinaryAdmin.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    cloudinaryAdmin: { destroyImages: adminMocks.destroyImages },
  };
});

import { scheduleProductImageCleanup } from "./cleanup.js";

beforeEach(() => {
  adminMocks.destroyImages.mockReset();
  vi.useRealTimers();
});

describe("scheduleProductImageCleanup (unit)", () => {
  it("destroys only URLs scoped to the tenant's Cloudinary folder", async () => {
    const tenantUrl = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/stores/store-aaa/uuid-1.png`;
    const otherTenantUrl = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/stores/store-bbb/uuid-2.png`;
    const externalUrl = "https://cdn.example.com/photo.jpg";
    adminMocks.destroyImages.mockResolvedValue({ deleted: {} });

    scheduleProductImageCleanup("store-aaa", [tenantUrl, otherTenantUrl, externalUrl]);

    await vi.waitFor(() => expect(adminMocks.destroyImages).toHaveBeenCalledTimes(1));
    expect(adminMocks.destroyImages).toHaveBeenCalledWith([
      `stores/store-aaa/uuid-1.png`,
    ]);
  });

  it("is fire-and-forget: failures never throw to the caller", async () => {
    const tenantUrl = `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/stores/store-aaa/uuid-1.png`;
    adminMocks.destroyImages.mockRejectedValue(new Error("network down"));

    expect(() => scheduleProductImageCleanup("store-aaa", [tenantUrl])).not.toThrow();
    await vi.waitFor(() => expect(adminMocks.destroyImages).toHaveBeenCalledTimes(1));
  });

  it("skips the API call entirely when no URLs belong to the tenant folder", () => {
    const externalUrl = "https://cdn.example.com/photo.jpg";

    scheduleProductImageCleanup("store-aaa", [externalUrl]);

    expect(adminMocks.destroyImages).not.toHaveBeenCalled();
  });
});
