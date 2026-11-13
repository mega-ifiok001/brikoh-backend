import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/AppError.js";
import { env } from "../../config/env.js";
import { ConsoleInviteSender, createResendClient, ResendInviteSender } from "./email.js";
import type { InviteEmailSender } from "./invite.service.js";
import {
  acceptInvite,
  createInvite,
  getAccountEmail,
  listPendingInvites,
  previewInvite,
  revokeInvite,
} from "./invite.service.js";
import { listStaff, removeStaffMember, updateStaffMember } from "./service.js";

/**
 * The wired invite email channel. Tests run under NODE_ENV=test and use
 * the console stub (never a real send); development and production use
 * the Resend sender. The Resend client boundary is unit-tested with a
 * mock; the integration suite never touches the network.
 */
function defaultInviteSender(): InviteEmailSender {
  if (process.env.NODE_ENV === "test") {
    return new ConsoleInviteSender();
  }
  return new ResendInviteSender(
    createResendClient(env.RESEND_API_KEY),
    env.RESEND_FROM_EMAIL_INVITE,
  );
}

function requireTenant(req: Request): { storeId: string } {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new AppError(401, "NEED_LOGIN", "Please log in to continue");
  }
  return { storeId: tenant.storeId };
}

function requireAccountId(req: Request): string {
  const account = req.account;
  if (account === undefined) {
    throw new AppError(401, "NEED_LOGIN", "Please log in to continue");
  }
  return account.accountId;
}

/** Express 5 types route params loosely; the routes always declare them. */
function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value === "") {
    throw new AppError(400, "VALIDATION_ERROR", `${name} is required`);
  }
  return value;
}

/** GET /api/dashboard/staff */
export async function listStaffHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const result = await listStaff(storeId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/dashboard/staff/:staffId */
export async function updateStaffHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const result = await updateStaffMember(storeId, param(req, "staffId"), req.body);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/dashboard/staff/:staffId */
export async function removeStaffHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    await removeStaffMember(storeId, param(req, "staffId"));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/staff/invites */
export async function listInvitesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const result = await listPendingInvites(storeId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/** POST /api/dashboard/staff/invites */
export async function createInviteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    const inviterEmail = await getAccountEmail(requireAccountId(req));
    const result = await createInvite(storeId, req.body, inviterEmail, defaultInviteSender());
    res.status(201).json({
      id: result.id,
      email: result.email,
      role: result.role,
      status: result.status,
      expiresAt: result.expiresAt,
      expiresInSeconds: result.expiresInSeconds,
    });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/dashboard/staff/invites/:inviteId */
export async function revokeInviteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { storeId } = requireTenant(req);
    await revokeInvite(storeId, param(req, "inviteId"));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

/** POST /api/public/auth/accept-invite */
export async function acceptInviteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await acceptInvite(req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/public/auth/accept-invite/:token */
export async function previewInviteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const preview = await previewInvite(param(req, "token"));
    res.status(200).json(preview);
  } catch (err) {
    next(err);
  }
}
