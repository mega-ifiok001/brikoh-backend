import { describe, expect, it } from "vitest";
import {
  buildTotpOtpauthUrl,
  generateTotpSecret,
  generateTotpToken,
  verifyTotpToken,
} from "./totp.js";

/**
 * TOTP (RFC 6238) helpers wrap otplib with a fixed policy: 30s period,
 * 6 digits, ±1 step verification window. The generated codes in these
 * tests are REAL codes computed by otplib from the seeded secret — the
 * same path the admin login uses, so a passing suite proves the
 * challenge/response loop end to end.
 */

describe("totp", () => {
  it("generates a base32 secret that otplib accepts (happy path)", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+={0,3}$/);
    expect(secret.length).toBeGreaterThanOrEqual(16);
  });

  it("generates a 6-digit numeric code from a secret (happy path)", () => {
    const secret = generateTotpSecret();
    expect(generateTotpToken(secret)).toMatch(/^\d{6}$/);
  });

  it("verifies a code generated from the same secret at the same time (happy path)", () => {
    const secret = generateTotpSecret();
    const token = generateTotpToken(secret);
    expect(verifyTotpToken(secret, token)).toBe(true);
  });

  it("rejects a wrong code (sad path)", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpToken(secret, "000000")).toBe(false);
  });

  it("rejects a non-numeric token (sad path)", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpToken(secret, "abcdef")).toBe(false);
  });

  it("rejects a code from outside the ±1 window (edge case)", () => {
    const secret = generateTotpSecret();
    const now = new Date();
    // 3 steps (90s) in the future is outside the ±1 verification window.
    const futureCode = generateTotpToken(secret, now.getTime() + 90_000);
    expect(verifyTotpToken(secret, futureCode, now)).toBe(false);
  });

  it("accepts a code one step in the past (edge case)", () => {
    const secret = generateTotpSecret();
    const now = new Date();
    const pastCode = generateTotpToken(secret, now.getTime() - 30_000);
    expect(verifyTotpToken(secret, pastCode, now)).toBe(true);
  });

  it("accepts a code one step in the future (edge case)", () => {
    const secret = generateTotpSecret();
    const now = new Date();
    const futureCode = generateTotpToken(secret, now.getTime() + 30_000);
    expect(verifyTotpToken(secret, futureCode, now)).toBe(true);
  });

  it("rejects an invalid base32 secret (sad path)", () => {
    expect(verifyTotpToken("not-valid-base32!!!", "123456")).toBe(false);
  });

  it("builds an otpauth URL embedding the secret and account name", () => {
    const secret = generateTotpSecret();
    const url = buildTotpOtpauthUrl(secret, "admin@brikoh.dev");
    expect(url.startsWith("otpauth://totp/")).toBe(true);
    expect(url).toContain(secret);
    // The label is percent-encoded per the otpauth URI spec; decoding
    // must recover the exact account name.
    expect(url).toContain("admin%40brikoh.dev");
    expect(decodeURIComponent(url)).toContain("admin@brikoh.dev");
  });
});
