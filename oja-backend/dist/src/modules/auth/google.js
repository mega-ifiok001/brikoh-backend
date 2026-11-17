import { OAuth2Client } from "google-auth-library";
import { AppError } from "../../lib/AppError.js";
/**
 * Real implementation: exchanges the authorization code with Google
 * using the client secret (server-side only) and verifies the returned
 * ID token (audience, issuer, expiry via Google's cached certs). A
 * Google-verified email is required — accounts signed in via Google are
 * pre-verified, so onboarding needs no separate email step.
 */
export function createGoogleOAuthClient(clientId, clientSecret) {
    const client = new OAuth2Client(clientId, clientSecret);
    return {
        async exchangeCode(code, redirectUri) {
            let profile;
            try {
                const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
                const idToken = tokens.id_token;
                if (typeof idToken !== "string") {
                    throw new AppError(401, "GOOGLE_AUTH_FAILED", "Google sign-in failed — please try again");
                }
                const login = await client.verifyIdToken({
                    idToken,
                    audience: clientId,
                });
                const payload = login.getPayload();
                if (payload === undefined) {
                    throw new AppError(401, "GOOGLE_AUTH_FAILED", "Google sign-in failed — please try again");
                }
                if (payload.sub === undefined || payload.email === undefined) {
                    throw new AppError(401, "GOOGLE_AUTH_FAILED", "Google sign-in failed — please try again");
                }
                if (payload.email_verified !== true) {
                    throw new AppError(400, "VALIDATION_ERROR", "Google hasn't verified this email — please use a verified email address");
                }
                profile = {
                    sub: payload.sub,
                    email: payload.email.toLowerCase(),
                    firstName: payload.given_name ?? null,
                    lastName: payload.family_name ?? null,
                };
            }
            catch (err) {
                if (err instanceof AppError)
                    throw err;
                throw new AppError(401, "GOOGLE_AUTH_FAILED", "Google sign-in failed — please try again");
            }
            return profile;
        },
    };
}
/**
 * Development stub: maps a code to a deterministic identity instead of
 * contacting Google. Only active under NODE_ENV=test (see the controller
 * factory), so the integration suite exercises the full sign-in flow
 * network-free. Codes outside the allowlist are rejected like a real
 * bad/expired code, letting tests exercise the failure path too. A new
 * integration scenario needs its code added here — just like a real
 * Google OAuth client would need the code to be issued by Google.
 */
const CONSOLE_KNOWN_CODES = new Set([
    "newowner",
    "existing",
    "linked",
    "disabled",
    "native",
    "localdev",
]);
export class ConsoleGoogleOAuthClient {
    async exchangeCode(code) {
        if (!CONSOLE_KNOWN_CODES.has(code)) {
            throw new AppError(401, "GOOGLE_AUTH_FAILED", "Google sign-in failed — please try again");
        }
        const slug = code.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase();
        return {
            sub: `stub-${slug}`,
            email: `${slug}@google.test`,
            firstName: "Google",
            lastName: "Test",
        };
    }
}
//# sourceMappingURL=google.js.map