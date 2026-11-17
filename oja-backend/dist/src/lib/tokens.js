import { randomBytes } from "node:crypto";
import jwt, {} from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "./AppError.js";
import { parseDurationToMs } from "./duration.js";
export const REFRESH_TOKEN_PREFIX = "rt_";
/**
 * Signs an access JWT. `expiresInOverride` exists for tests (e.g. an
 * already-expired token); production callers use the env-configured
 * lifetime.
 */
export function signAccessToken(claims, expiresInOverride) {
    return jwt.sign(claims, env.JWT_SECRET, {
        // The override exists for tests (e.g. an already-expired token);
        // production always uses the env-configured lifetime.
        expiresIn: (expiresInOverride ?? env.JWT_ACCESS_EXPIRES_IN),
    });
}
/**
 * Verifies an access token. Distinguishes expired from invalid tokens.
 */
export function verifyAccessToken(token) {
    let payload;
    try {
        payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] });
    }
    catch (err) {
        if (err instanceof jwt.TokenExpiredError) {
            throw new AppError(401, "SESSION_EXPIRED", "Your session has expired — please log in again");
        }
        throw new AppError(401, "INVALID_TOKEN", "Invalid access token — please log in again");
    }
    if (typeof payload === "string" || typeof payload.sub !== "string") {
        throw new AppError(401, "INVALID_TOKEN", "Invalid access token — please log in again");
    }
    return payload;
}
/** 32 random bytes as base64url — 43 chars, url-safe, no padding. */
export function generateRefreshTokenSecret() {
    return randomBytes(32).toString("base64url");
}
/** Builds the raw client-visible refresh token. */
export function formatRefreshToken(tokenId, secret) {
    return `${REFRESH_TOKEN_PREFIX}${tokenId}.${secret}`;
}
/**
 * Splits a raw refresh token (`rt_<tokenId>.<secret>`) into its id and
 * secret halves. Returns null for anything that does not match — the
 * prefix must be exactly "rt_", and both halves must be non-empty.
 */
export function parseRefreshToken(raw) {
    if (!raw.startsWith(REFRESH_TOKEN_PREFIX)) {
        return null;
    }
    const rest = raw.slice(REFRESH_TOKEN_PREFIX.length);
    const dot = rest.indexOf(".");
    if (dot <= 0 || dot === rest.length - 1) {
        return null;
    }
    return { tokenId: rest.slice(0, dot), secret: rest.slice(dot + 1) };
}
/** Refresh-token row lifetime, from the validated env (default 7d). */
export function refreshTokenLifetimeMs() {
    return parseDurationToMs(env.JWT_REFRESH_EXPIRES_IN);
}
//# sourceMappingURL=tokens.js.map