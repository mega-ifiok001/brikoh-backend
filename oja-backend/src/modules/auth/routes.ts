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
} from "./controller.js";

const authRouter: Router = Router();

authRouter.post("/register", registerHandler);
authRouter.post("/login", loginHandler);
authRouter.post("/google", googleSignInHandler);
authRouter.post("/refresh", refreshHandler);
authRouter.post("/logout", logoutHandler);
// The verification token IS the credential (single-use, mailed), so the
// verify endpoint lives in the public auth group like accept-invite.
authRouter.post("/verify", verifyHandler);
authRouter.post(
  "/forgot-password",
  rateLimit({ windowMs: 60_000, max: 10 }),
  forgotPasswordHandler,
);
authRouter.post("/reset-password", rateLimit({ windowMs: 60_000, max: 10 }), resetPasswordHandler);

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
resendVerificationRouter.post("/", resendVerificationHandler);

export {
  authRouter,
  dashboardAccountRouter,
  dashboardMeRouter,
  dashboardPasswordRouter,
  onboardingRouter,
  resendVerificationRouter,
};
