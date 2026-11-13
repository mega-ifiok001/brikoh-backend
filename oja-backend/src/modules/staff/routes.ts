import { Router } from "express";
import {
  acceptInviteHandler,
  createInviteHandler,
  listInvitesHandler,
  listStaffHandler,
  previewInviteHandler,
  removeStaffHandler,
  revokeInviteHandler,
  updateStaffHandler,
} from "./controller.js";

/**
 * Owner-only staff management. Mounted under authenticate + resolveTenant
 * + requireOwner in app.ts. Invite routes are declared before the
 * :staffId routes so "invites" never matches a staff id.
 */
const staffRouter: Router = Router();

staffRouter.get("/", listStaffHandler);
staffRouter.get("/invites", listInvitesHandler);
staffRouter.post("/invites", createInviteHandler);
staffRouter.delete("/invites/:inviteId", revokeInviteHandler);
staffRouter.patch("/:staffId", updateStaffHandler);
staffRouter.delete("/:staffId", removeStaffHandler);

/**
 * The public half of the invite lifecycle. Mounted on the public auth
 * group in app.ts (rate-limited); the invite token is the credential,
 * so no bearer token is required or expected.
 */
const invitePublicRouter: Router = Router();
invitePublicRouter.post("/accept-invite", acceptInviteHandler);
invitePublicRouter.get("/accept-invite/:token", previewInviteHandler);

export { invitePublicRouter, staffRouter };
