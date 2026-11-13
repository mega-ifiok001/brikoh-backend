import { describe, expect, it } from "vitest";
import type { AppError } from "./AppError.js";
import {
  formatRefreshToken,
  generateRefreshTokenSecret,
  parseRefreshToken,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
} from "./tokens.js";

const CLAIMS: AccessTokenClaims = {
  sub: "account-1",
  storeId: "store-1",
  role: "OWNER",
};

describe("tokens (unit)", () => {
  describe("access tokens", () => {
    it("round-trips a signed token back to its claims", () => {
      const token = signAccessToken(CLAIMS);
      const payload = verifyAccessToken(token);

      expect(payload.sub).toBe("account-1");
      expect(payload.storeId).toBe("store-1");
      expect(payload.role).toBe("OWNER");
      expect(payload.iat).toBeTypeOf("number");
      expect(payload.exp).toBeTypeOf("number");
      expect(payload.exp).toBeGreaterThan(payload.iat);
    });

    it("throws INVALID_TOKEN for a token that is not a JWT", () => {
      expect(() => verifyAccessToken("not-a-jwt")).toThrowError(
        expect.objectContaining({ code: "INVALID_TOKEN", statusCode: 401 }),
      );
    });

    it("throws INVALID_TOKEN for a tampered token (wrong signature)", () => {
      const token = signAccessToken(CLAIMS);
      const tampered = `${token.slice(0, -3)}abc`;
      expect(() => verifyAccessToken(tampered)).toThrowError(
        expect.objectContaining({ code: "INVALID_TOKEN" }),
      );
    });

    it("throws SESSION_EXPIRED for an expired token", () => {
      const expired = signAccessToken(CLAIMS, "-5s");
      try {
        verifyAccessToken(expired);
        expect.unreachable("should have thrown");
      } catch (err) {
        const error = err as AppError;
        expect(error.code).toBe("SESSION_EXPIRED");
        expect(error.statusCode).toBe(401);
        expect(error.message).toMatch(/expired/i);
      }
    });

    it("throws INVALID_TOKEN for a token missing the sub claim", () => {
      const token = signAccessToken({ role: "OWNER" } as AccessTokenClaims);
      expect(() => verifyAccessToken(token)).toThrowError(
        expect.objectContaining({ code: "INVALID_TOKEN" }),
      );
    });
  });

  describe("refresh tokens", () => {
    it("generates a secret that is url-safe and 43 chars (32 random bytes)", () => {
      const secret = generateRefreshTokenSecret();
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it("formats and parses rt_<tokenId>.<secret>", () => {
      const raw = formatRefreshToken("token-1", "secret-value");
      expect(raw).toBe("rt_token-1.secret-value");
      expect(parseRefreshToken(raw)).toEqual({ tokenId: "token-1", secret: "secret-value" });
    });

    it("returns null for malformed raw tokens", () => {
      expect(parseRefreshToken("")).toBeNull();
      expect(parseRefreshToken("token-1.secret")).toBeNull();
      expect(parseRefreshToken("rt_token-1")).toBeNull();
      expect(parseRefreshToken("rt_.secret")).toBeNull();
      expect(parseRefreshToken("rt_token-1.")).toBeNull();
      expect(parseRefreshToken("xx_token-1.secret")).toBeNull();
    });
  });
});
