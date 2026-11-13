import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "./AppError.js";
import { parseDurationToMs } from "./duration.js";

/**
 * Admin access tokens are a SEPARATE token type from the merchant tokens
 * in tokens.ts: a distinct secret (ADMIN_JWT_SECRET), distinct claims
 * (sub = adminUserId, role = role name), and a distinct issuer path (only
 * the admin login endpoint, after a verified TOTP). Merchant middleware
 * (authenticate) and admin middleware (requireAdminAuth) never accept
 * each other's tokens.
 */

export interface AdminAccessTokenClaims {
  sub: string;
  role: string;
}

export interface AdminAccessTokenPayload extends AdminAccessTokenClaims {
  iat: number;
  exp: number;
}

/**
 * Signs an admin access JWT with the ADMIN secret. `expiresInOverride`
 * exists for tests; production uses the env-configured lifetime.
 */
export function signAdminAccessToken(
  claims: AdminAccessTokenClaims,
  expiresInOverride?: string | number,
): string {
  return jwt.sign(claims, env.ADMIN_JWT_SECRET, {
    expiresIn: (expiresInOverride ?? env.ADMIN_JWT_ACCESS_EXPIRES_IN) as SignOptions["expiresIn"],
  });
}

/**
 * Verifies an admin access token with the ADMIN secret. Every failure —
 * malformed, tampered, expired, merchant-token-signed — surfaces as the
 * same 401 UNAUTHORIZED.
 */
export function verifyAdminAccessToken(token: string): AdminAccessTokenPayload {
  let payload: jwt.JwtPayload | string;
  try {
    payload = jwt.verify(token, env.ADMIN_JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Invalid admin access token");
  }
  if (typeof payload === "string" || typeof payload.sub !== "string") {
    throw new AppError(401, "UNAUTHORIZED", "Invalid admin access token");
  }
  return payload as AdminAccessTokenPayload;
}

export function adminRefreshTokenLifetimeMs(): number {
  return parseDurationToMs(env.ADMIN_JWT_REFRESH_EXPIRES_IN);
}
