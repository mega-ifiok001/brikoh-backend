import jwt, {} from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "./AppError.js";
import { parseDurationToMs } from "./duration.js";
/**
 * Signs an admin access JWT with the ADMIN secret. `expiresInOverride`
 * exists for tests; production uses the env-configured lifetime.
 */
export function signAdminAccessToken(claims, expiresInOverride) {
    return jwt.sign(claims, env.ADMIN_JWT_SECRET, {
        expiresIn: (expiresInOverride ?? env.ADMIN_JWT_ACCESS_EXPIRES_IN),
    });
}
/**
 * Verifies an admin access token with the ADMIN secret. Every failure —
 * malformed, tampered, expired, merchant-token-signed — surfaces as the
 * same 401 UNAUTHORIZED.
 */
export function verifyAdminAccessToken(token) {
    let payload;
    try {
        payload = jwt.verify(token, env.ADMIN_JWT_SECRET, { algorithms: ["HS256"] });
    }
    catch {
        throw new AppError(401, "UNAUTHORIZED", "Invalid admin access token");
    }
    if (typeof payload === "string" || typeof payload.sub !== "string") {
        throw new AppError(401, "UNAUTHORIZED", "Invalid admin access token");
    }
    return payload;
}
export function adminRefreshTokenLifetimeMs() {
    return parseDurationToMs(env.ADMIN_JWT_REFRESH_EXPIRES_IN);
}
//# sourceMappingURL=adminTokens.js.map