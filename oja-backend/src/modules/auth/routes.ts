import { Router } from "express";
import { rateLimit } from "../../middleware/rateLimit.js";
import {
  changePasswordHandler,
  deleteAccountHandler,
  forgotPasswordHandler,
  googleSignInHandler,
  loginHandler,
  logoutHandler,
  meHandler,
  onboardingHandler,
  refreshHandler,
  registerHandler,
  resendVerificationHandler,
  resetPasswordHandler,
  verifyHandler,
  verifyPasswordResetOtpHandler,
} from "./controller.js";

const authRouter: Router = Router();

authRouter.post("/register", rateLimit({ windowMs: 60_000, max: 10 }), registerHandler);
authRouter.post("/login", loginHandler);
authRouter.post("/google", googleSignInHandler);
authRouter.post("/refresh", refreshHandler);
authRouter.post("/logout", logoutHandler);
// Email/code pairs are the credential; the short-lived OTP is purpose-bound
// to the email and account, and verified once.
authRouter.post("/verify", rateLimit({ windowMs: 60_000, max: 10 }), verifyHandler);
authRouter.post(
  "/forgot-password",
  rateLimit({ windowMs: 60_000, max: 10 }),
  forgotPasswordHandler,
);
authRouter.post("/reset-password", rateLimit({ windowMs: 60_000, max: 10 }), resetPasswordHandler);
authRouter.post(
  "/reset-password/verify",
  rateLimit({ windowMs: 60_000, max: 10 }),
  verifyPasswordResetOtpHandler,
);

const dashboardMeRouter: Router = Router();
dashboardMeRouter.get("/", meHandler);

// Account lifecycle (authenticate only, no tenant context): changing the
// password must keep working for pre-onboarding accounts, and deleting
// the account IS the way to remove a tenant.
const dashboardPasswordRouter: Router = Router();
dashboardPasswordRouter.post("/", changePasswordHandler);

const dashboardAccountRouter: Router = Router();
dashboardAccountRouter.delete("/", deleteAccountHandler);

const onboardingRouter: Router = Router();
onboardingRouter.post("/", onboardingHandler);

// Account-level (authenticate only, like /me): resending verification
// needs the session but no tenant context.
const resendVerificationRouter: Router = Router();
resendVerificationRouter.post(
  "/",
  rateLimit({ windowMs: 15 * 60_000, max: 5 }),
  resendVerificationHandler,
);

export {
  authRouter,
  dashboardAccountRouter,
  dashboardMeRouter,
  dashboardPasswordRouter,
  onboardingRouter,
  resendVerificationRouter,
};
