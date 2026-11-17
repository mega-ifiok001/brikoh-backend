import { env } from "../../config/env.js";
import { AppError } from "../../lib/AppError.js";
import { ConsoleVerificationSender, ConsoleWelcomeSender, createResendClient, ResendVerificationSender, ResendWelcomeSender, } from "./email.js";
import { ConsoleGoogleOAuthClient, createGoogleOAuthClient, } from "./google.js";
import { changePassword, deleteAccount, getMe, googleSignIn, login, logout, onboardAccount, refresh, register, resendVerification, verifyEmail, } from "./service.js";
/**
 * The wired verification-email channel. Tests run under NODE_ENV=test
 * and use the console stub (never a real send); development and
 * production use the Resend sender. The Resend client boundary is
 * unit-tested with a mock; the integration suite never touches the
 * network.
 */
function defaultVerificationSender() {
    if (process.env.NODE_ENV === "test") {
        return new ConsoleVerificationSender();
    }
    return new ResendVerificationSender(createResendClient(env.RESEND_API_KEY), env.RESEND_FROM_EMAIL_ACCOUNT);
}
/** The wired welcome-email channel — same stub/Resend split as verification. */
function defaultWelcomeSender() {
    if (process.env.NODE_ENV === "test") {
        return new ConsoleWelcomeSender();
    }
    return new ResendWelcomeSender(createResendClient(env.RESEND_API_KEY), env.RESEND_FROM_EMAIL_ACCOUNT);
}
/**
 * The wired Google OAuth channel. Tests run under NODE_ENV=test and use
 * the console stub (deterministic identity per code, never a network
 * call); development and production exchange codes with Google using the
 * client secret.
 */
function defaultGoogleOAuthClient() {
    if (process.env.NODE_ENV === "test") {
        return new ConsoleGoogleOAuthClient();
    }
    return createGoogleOAuthClient(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
}
/** POST /api/public/auth/register */
export async function registerHandler(req, res, next) {
    try {
        const result = await register(req.body, defaultVerificationSender());
        res.status(201).json(result);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/public/auth/login */
export async function loginHandler(req, res, next) {
    try {
        const result = await login(req.body);
        res.status(200).json(result);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/public/auth/google */
export async function googleSignInHandler(req, res, next) {
    try {
        const result = await googleSignIn(defaultGoogleOAuthClient(), req.body);
        res.status(200).json(result);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/public/auth/refresh */
export async function refreshHandler(req, res, next) {
    try {
        const result = await refresh(req.body?.refreshToken);
        res.status(200).json(result);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/public/auth/logout */
export async function logoutHandler(req, res, next) {
    try {
        await logout(req.body?.refreshToken);
        res.status(204).send();
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/public/auth/verify */
export async function verifyHandler(req, res, next) {
    try {
        const result = await verifyEmail(req.body?.token);
        res.status(200).json(result);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/resend-verification */
export async function resendVerificationHandler(req, res, next) {
    const account = req.account;
    if (account === undefined) {
        next(new AppError(401, "UNAUTHORIZED", "Authentication required"));
        return;
    }
    try {
        const result = await resendVerification(account.accountId, defaultVerificationSender());
        res.status(200).json(result);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/onboarding */
export async function onboardingHandler(req, res, next) {
    const account = req.account;
    if (account === undefined) {
        next(new AppError(401, "UNAUTHORIZED", "Authentication required"));
        return;
    }
    try {
        const user = await onboardAccount(account.accountId, req.body, defaultWelcomeSender());
        res.status(201).json({ user });
    }
    catch (err) {
        next(err);
    }
}
/** GET /api/dashboard/me */
export async function meHandler(req, res, next) {
    const account = req.account;
    if (account === undefined) {
        next(new AppError(401, "UNAUTHORIZED", "Authentication required"));
        return;
    }
    try {
        const result = await getMe(account.accountId);
        res.status(200).json(result);
    }
    catch (err) {
        next(err);
    }
}
/** POST /api/dashboard/settings/password */
export async function changePasswordHandler(req, res, next) {
    const account = req.account;
    if (account === undefined) {
        next(new AppError(401, "UNAUTHORIZED", "Authentication required"));
        return;
    }
    try {
        await changePassword(account.accountId, req.body);
        res.status(200).json({ ok: true });
    }
    catch (err) {
        next(err);
    }
}
/** DELETE /api/dashboard/account */
export async function deleteAccountHandler(req, res, next) {
    const account = req.account;
    if (account === undefined) {
        next(new AppError(401, "UNAUTHORIZED", "Authentication required"));
        return;
    }
    try {
        await deleteAccount(account.accountId);
        res.status(200).json({ ok: true });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=controller.js.map