import { describe, expect, it } from "vitest";
import { googleRedirectUris, loadEnv } from "./env.js";

const baseEnv = {
  NODE_ENV: "test",
  TRUST_PROXY: "0",
  DATABASE_URL: "postgresql://user:pass@host:5432/db",
  TEST_DATABASE_URL: "postgresql://user:pass@host:5432/testdb",
  JWT_SECRET: "a-very-long-secret-value-for-tests-12345",
  JWT_REFRESH_SECRET: "another-very-long-secret-value-for-tests-123",
  JWT_ACCESS_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
  ADMIN_JWT_SECRET: "an-admin-long-secret-value-for-tests-12345",
  ADMIN_JWT_ACCESS_EXPIRES_IN: "15m",
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-api-key",
  CLOUDINARY_API_SECRET: "test-secret-key",
  PLATFORM_PAYSTACK_SECRET_KEY: "sk_test_platform",
  PLATFORM_PAYSTACK_PUBLIC_KEY: "pk_test_platform",
  FRONTEND_URL: "https://app.example.com",
  INVITE_EXPIRES_IN: "7d",
  RESEND_API_KEY: "re_test-key",
  RESEND_FROM_EMAIL_ACCOUNT: "welcome@example.com",
  RESEND_FROM_EMAIL_INVITE: "invites@example.com",
  RESEND_FROM_EMAIL_ALERT: "notifications@example.com",
  RESEND_FROM_EMAIL_RECEIPT: "receipts@example.com",
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  // 32-byte master key as 64 hex chars — PAYMENT_ENCRYPTION_KEY
  PAYMENT_ENCRYPTION_KEY: "a1".repeat(32),
};

describe("loadEnv", () => {
  it("parses a complete environment into the typed config", () => {
    const env = loadEnv(baseEnv);

    expect(env.NODE_ENV).toBe("test");
    expect(env.PORT).toBe(4000);
    expect(env.DATABASE_URL).toBe(baseEnv.DATABASE_URL);
  });

  it("throws when a required variable is missing", () => {
    const withoutSecret = Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => key !== "JWT_SECRET"),
    );

    expect(() => loadEnv(withoutSecret)).toThrow(/JWT_SECRET/);
  });

  it("throws when a variable is malformed", () => {
    expect(() => loadEnv({ ...baseEnv, PORT: "not-a-port" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("throws when a secret is too short (edge case)", () => {
    expect(() => loadEnv({ ...baseEnv, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
  });

  it("throws when NODE_ENV is not a known value (edge case)", () => {
    expect(() => loadEnv({ ...baseEnv, NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });

  it("throws when the refresh secret is missing", () => {
    const withoutRefreshSecret = Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => key !== "JWT_REFRESH_SECRET"),
    );

    expect(() => loadEnv(withoutRefreshSecret)).toThrow(/JWT_REFRESH_SECRET/);
  });

  it("throws when a Cloudinary variable is missing", () => {
    const withoutCloudName = Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => key !== "CLOUDINARY_CLOUD_NAME"),
    );

    expect(() => loadEnv(withoutCloudName)).toThrow(/CLOUDINARY_CLOUD_NAME/);
  });

  it("defaults CLOUDINARY_FOLDER_PREFIX to stores and trims it", () => {
    const withoutPrefix = Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => key !== "CLOUDINARY_FOLDER_PREFIX"),
    );

    expect(loadEnv(withoutPrefix).CLOUDINARY_FOLDER_PREFIX).toBe("stores");
    expect(loadEnv({ ...baseEnv, CLOUDINARY_FOLDER_PREFIX: " media " }).CLOUDINARY_FOLDER_PREFIX).toBe(
      "media",
    );
  });

  it("throws when FRONTEND_URL is missing or malformed", () => {
    const withoutFrontend = Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => key !== "FRONTEND_URL"),
    );

    expect(() => loadEnv(withoutFrontend)).toThrow(/FRONTEND_URL/);
    expect(() => loadEnv({ ...baseEnv, FRONTEND_URL: "not-a-url" })).toThrow(/FRONTEND_URL/);
  });

  it("defaults INVITE_EXPIRES_IN to 7d and accepts valid durations", () => {
    const withoutExpiry = Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => key !== "INVITE_EXPIRES_IN"),
    );

    expect(loadEnv(withoutExpiry).INVITE_EXPIRES_IN).toBe("7d");
    expect(loadEnv({ ...baseEnv, INVITE_EXPIRES_IN: "1h" }).INVITE_EXPIRES_IN).toBe("1h");
    expect(() => loadEnv({ ...baseEnv, INVITE_EXPIRES_IN: "abc" })).toThrow(/INVITE_EXPIRES_IN/);
  });

  it("throws when a Resend variable is missing or malformed", () => {
    const withoutKey = Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => key !== "RESEND_API_KEY"),
    );

    expect(() => loadEnv(withoutKey)).toThrow(/RESEND_API_KEY/);
    expect(() => loadEnv({ ...baseEnv, RESEND_FROM_EMAIL_ACCOUNT: "not-an-email" })).toThrow(
      /RESEND_FROM_EMAIL_ACCOUNT/,
    );
    expect(() => loadEnv({ ...baseEnv, RESEND_FROM_EMAIL_INVITE: "not-an-email" })).toThrow(
      /RESEND_FROM_EMAIL_INVITE/,
    );
    expect(() => loadEnv({ ...baseEnv, RESEND_FROM_EMAIL_ALERT: "not-an-email" })).toThrow(
      /RESEND_FROM_EMAIL_ALERT/,
    );
  });

  it("throws when an expiry duration is missing", () => {
    const withoutAccessExpiry = Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => key !== "JWT_ACCESS_EXPIRES_IN"),
    );

    expect(() => loadEnv(withoutAccessExpiry)).toThrow(/JWT_ACCESS_EXPIRES_IN/);
  });

  it("throws when PAYMENT_ENCRYPTION_KEY is missing, non-hex, or not 32 bytes", () => {
    const withoutKey = Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => key !== "PAYMENT_ENCRYPTION_KEY"),
    );

    expect(() => loadEnv(withoutKey)).toThrow(/PAYMENT_ENCRYPTION_KEY/);
    expect(() => loadEnv({ ...baseEnv, PAYMENT_ENCRYPTION_KEY: "not-hex" })).toThrow(
      /PAYMENT_ENCRYPTION_KEY/,
    );
    expect(() => loadEnv({ ...baseEnv, PAYMENT_ENCRYPTION_KEY: "aa" })).toThrow(
      /PAYMENT_ENCRYPTION_KEY/,
    );
  });

  it("throws when a duration is malformed", () => {
    expect(() => loadEnv({ ...baseEnv, JWT_ACCESS_EXPIRES_IN: "abc" })).toThrow(
      /JWT_ACCESS_EXPIRES_IN/,
    );
    expect(() => loadEnv({ ...baseEnv, JWT_REFRESH_EXPIRES_IN: "15" })).toThrow(
      /JWT_REFRESH_EXPIRES_IN/,
    );
  });

  it("accepts valid duration units (edge cases)", () => {
    expect(loadEnv({ ...baseEnv, JWT_ACCESS_EXPIRES_IN: "30s" }).JWT_ACCESS_EXPIRES_IN).toBe("30s");
    expect(loadEnv({ ...baseEnv, JWT_ACCESS_EXPIRES_IN: "24h" }).JWT_ACCESS_EXPIRES_IN).toBe("24h");
    expect(loadEnv({ ...baseEnv, JWT_ACCESS_EXPIRES_IN: "2d" }).JWT_ACCESS_EXPIRES_IN).toBe("2d");
  });

  it("defaults TRUST_PROXY to off and only accepts 0/1", () => {
    const withoutProxy = Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => key !== "TRUST_PROXY"),
    );

    expect(loadEnv(withoutProxy).TRUST_PROXY).toBe(false);
    expect(loadEnv(baseEnv).TRUST_PROXY).toBe(false);
    expect(loadEnv({ ...baseEnv, TRUST_PROXY: "1" }).TRUST_PROXY).toBe(true);
    expect(() => loadEnv({ ...baseEnv, TRUST_PROXY: "yes" })).toThrow(/TRUST_PROXY/);
  });

  it("throws when a Google OAuth variable is missing", () => {
    const withoutId = Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => key !== "GOOGLE_CLIENT_ID"),
    );
    const withoutSecret = Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => key !== "GOOGLE_CLIENT_SECRET"),
    );

    expect(() => loadEnv(withoutId)).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() => loadEnv(withoutSecret)).toThrow(/GOOGLE_CLIENT_SECRET/);
  });

  it("derives the Google redirect URIs from every frontend origin", () => {
    const env = loadEnv({
      ...baseEnv,
      CORS_EXTRA_ORIGINS: "https://preview-1.arena.site,https://preview-2.arena.site",
    });

    expect(googleRedirectUris(env)).toEqual([
      "https://app.example.com/auth/google/callback",
      "https://preview-1.arena.site/auth/google/callback",
      "https://preview-2.arena.site/auth/google/callback",
    ]);
  });

  it("defaults CORS_EXTRA_ORIGINS to an empty list", () => {
    expect(loadEnv(baseEnv).CORS_EXTRA_ORIGINS).toEqual([]);
  });

  it("parses CORS_EXTRA_ORIGINS as a trimmed comma-separated list", () => {
    const env = loadEnv({
      ...baseEnv,
      CORS_EXTRA_ORIGINS: " https://preview-1.arena.site , https://preview-2.arena.site ,",
    });

    expect(env.CORS_EXTRA_ORIGINS).toEqual([
      "https://preview-1.arena.site",
      "https://preview-2.arena.site",
    ]);
  });
});
