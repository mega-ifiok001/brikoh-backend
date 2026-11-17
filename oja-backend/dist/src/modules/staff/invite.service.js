import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/AppError.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { parseDurationToMs } from "../../lib/duration.js";
import { signAccessToken } from "../../lib/tokens.js";
import { logStoreActivity } from "../activity/service.js";
import { BCRYPT_COST, issueRefreshToken } from "../auth/service.js";
import { acceptInviteSchema, inviteSchema, validateOrThrow } from "./schemas.js";
/** Default permission flags granted on acceptance, by invite role. */
export const ROLE_DEFAULT_PERMISSIONS = {
    ADMIN: [
        "products.manage",
        "orders.manage",
        "customers.manage",
        "invoices.manage",
        "purchases.manage",
        "discounts.manage",
    ],
    MANAGER: ["products.manage", "orders.manage"],
    STAFF: ["orders.manage"],
};
/** Fresh single-use invite token: `inv_` + 32 bytes base64url. */
export function generateInviteToken() {
    return `inv_${randomBytes(32).toString("base64url")}`;
}
/** Invite validity window from the validated env (default 7d). */
export function inviteLifetimeMs() {
    return parseDurationToMs(env.INVITE_EXPIRES_IN);
}
/** The authenticated account's email, for "who invited them" in the email. */
export async function getAccountEmail(accountId) {
    const account = await getPrismaClient().account.findUnique({
        where: { id: accountId },
        select: { email: true },
    });
    if (account === null) {
        throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
    }
    return account.email;
}
export async function listPendingInvites(storeId) {
    const rows = await getPrismaClient().inviteToken.findMany({
        where: { storeId, status: "PENDING" },
        orderBy: { createdAt: "asc" },
    });
    return {
        items: rows.map((row) => ({
            id: row.id,
            email: row.email,
            role: row.role,
            status: row.status,
            expiresAt: row.expiresAt,
            createdAt: row.createdAt,
        })),
    };
}
/**
 * Creates an InviteToken for a new staff member after enforcing the
 * store's staff cap (see header). Sends the invite email after the
 * transaction; delivery failure is logged, never thrown.
 */
export async function createInvite(storeId, input, inviterEmail, sender) {
    const data = validateOrThrow(inviteSchema, input);
    const prisma = getPrismaClient();
    const invite = await prisma.$transaction(async (tx) => {
        // Serialize invites per store so the count check below can't race
        // with a concurrent invite committing between COUNT and INSERT.
        await tx.$queryRaw `SELECT id FROM "Store" WHERE id = ${storeId} FOR UPDATE`;
        // More specific first: an email that is ALREADY a staff member here
        // is a clearer error than the generic account-exists one.
        const existingStaff = await tx.staffMember.findFirst({
            where: { storeId, account: { email: data.email } },
        });
        if (existingStaff !== null) {
            throw new AppError(409, "ALREADY_STAFF", "That email already belongs to an active staff member of this store");
        }
        const existingAccount = await tx.account.findUnique({ where: { email: data.email } });
        if (existingAccount !== null) {
            throw new AppError(409, "EMAIL_TAKEN", "An account with that email already exists — an existing account cannot be invited");
        }
        const store = await tx.store.findUnique({
            where: { id: storeId },
            include: { subscription: true },
        });
        if (store === null) {
            throw new AppError(404, "STORE_NOT_FOUND", "Store not found");
        }
        const staffCap = store.subscription?.staffCap ?? null;
        if (staffCap !== null) {
            const activeStaff = await tx.staffMember.count({ where: { storeId } });
            if (activeStaff >= staffCap) {
                const upgradePlan = store.subscription?.tier === "STARTER" ? "PRO" : "ENTERPRISE";
                throw new AppError(409, "STAFF_LIMIT_REACHED", `This plan allows ${staffCap} staff member(s); the limit is reached — upgrade to ${upgradePlan} for more`);
            }
        }
        const existingInvite = await tx.inviteToken.findFirst({
            where: { storeId, email: data.email, status: "PENDING" },
        });
        if (existingInvite !== null) {
            await tx.inviteToken.update({
                where: { id: existingInvite.id },
                data: { status: "EXPIRED" },
            });
        }
        const token = generateInviteToken();
        const expiresAt = new Date(Date.now() + inviteLifetimeMs());
        const invite = await tx.inviteToken.create({
            data: { token, email: data.email, storeId, role: data.role, expiresAt },
        });
        return { invite, storeName: store.name };
    });
    await sendInviteEmailBestEffort(sender, {
        to: invite.invite.email,
        storeName: invite.storeName,
        inviterEmail,
        token: invite.invite.token,
        expiresAt: invite.invite.expiresAt,
    });
    return {
        id: invite.invite.id,
        token: invite.invite.token,
        email: invite.invite.email,
        role: invite.invite.role,
        status: "PENDING",
        expiresAt: invite.invite.expiresAt,
        expiresInSeconds: Math.floor(inviteLifetimeMs() / 1000),
    };
}
/**
 * Best-effort email send: never throws into the invite flow. Delivery
 * failures are logged so a silently-dropped invite cannot disappear.
 * TODO(phase-13): route through structured logging when it lands.
 */
async function sendInviteEmailBestEffort(sender, data) {
    try {
        await sender.sendInviteEmail(data);
    }
    catch (err) {
        console.error(`[invite-email] failed to send invite to ${data.to}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/** Deletes a PENDING invite; unknown, cross-store, or used invites are 404. */
export async function revokeInvite(storeId, inviteId) {
    const result = await getPrismaClient().inviteToken.deleteMany({
        where: { id: inviteId, storeId, status: "PENDING" },
    });
    if (result.count === 0) {
        throw new AppError(404, "INVITE_NOT_FOUND", "No pending invite found — it may have been accepted or expired");
    }
}
/**
 * Completes an invite: Account + StaffMember created and the token
 * marked ACCEPTED in ONE transaction, then a token pair issued (the
 * invitee is logged in immediately, mirroring register). The acceptance
 * is a conditional update, so two concurrent requests presenting the
 * same token race safely — exactly one wins, the loser is rejected as
 * reused.
 */
export async function acceptInvite(input) {
    const data = validateOrThrow(acceptInviteSchema, input);
    const prisma = getPrismaClient();
    const created = await prisma.$transaction(async (tx) => {
        const invite = await tx.inviteToken.findUnique({
            where: { token: data.token },
            include: { store: { select: { id: true, name: true, subdomain: true } } },
        });
        if (invite === null || invite.status !== "PENDING") {
            throw new AppError(400, "INVITE_INVALID", "This invite link is invalid or has already been used");
        }
        if (invite.expiresAt.getTime() <= Date.now()) {
            throw new AppError(400, "INVITE_EXPIRED", "This invite has expired — request a new one");
        }
        const existingAccount = await tx.account.findUnique({ where: { email: invite.email } });
        if (existingAccount !== null) {
            throw new AppError(400, "INVITE_INVALID", "An account already exists for this email — sign in instead");
        }
        const accepted = await tx.inviteToken.updateMany({
            where: { id: invite.id, status: "PENDING" },
            data: { status: "ACCEPTED" },
        });
        if (accepted.count === 0) {
            // Lost the single-use race: a concurrent accept already won.
            throw new AppError(400, "INVITE_INVALID", "This invite has already been used");
        }
        const passwordHash = await bcrypt.hash(data.password, BCRYPT_COST);
        const account = await tx.account.create({
            data: { email: invite.email, passwordHash },
        });
        const staffMember = await tx.staffMember.create({
            data: {
                accountId: account.id,
                storeId: invite.storeId,
                role: invite.role,
                permissions: ROLE_DEFAULT_PERMISSIONS[invite.role],
                inviteTokenId: invite.id,
            },
        });
        await logStoreActivity(tx, {
            storeId: invite.storeId,
            action: "staff.joined",
            detail: { staffMemberId: staffMember.id, email: invite.email, role: invite.role },
        });
        return {
            accountId: account.id,
            email: account.email,
            role: invite.role,
            storeId: invite.storeId,
            storeName: invite.store.name,
            subdomain: invite.store.subdomain,
            staffMemberId: staffMember.id,
        };
    });
    const refreshToken = await issueRefreshToken(created.accountId);
    const accessToken = signAccessToken({
        sub: created.accountId,
        storeId: created.storeId,
        role: created.role,
        staffMemberId: created.staffMemberId,
    });
    return { accessToken, refreshToken, user: created };
}
/**
 * Read-only preview of a pending invite, used by the frontend /invite page
 * to render context (store, role, inviter) and to validate the link before
 * the user sets a password. Mirrors the error codes of acceptInvite so the
 * client can show one "broken/expired — ask owner to resend" state.
 *
 * The inviter is derived from the store owner: invites are owner-only today,
 * so the inviting account is always the store's owner. No InviteToken column
 * is needed for this.
 */
export async function previewInvite(token) {
    const invite = await getPrismaClient().inviteToken.findUnique({
        where: { token },
        include: {
            store: {
                select: {
                    name: true,
                    owner: { select: { account: { select: { email: true } } } },
                },
            },
        },
    });
    if (invite === null || invite.status !== "PENDING") {
        throw new AppError(400, "INVITE_INVALID", "This invite link is invalid or has already been used");
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
        throw new AppError(400, "INVITE_EXPIRED", "This invite has expired — request a new one");
    }
    return {
        email: invite.email,
        storeName: invite.store.name,
        role: invite.role,
        inviterEmail: invite.store.owner?.account.email ?? "",
        expiresAt: invite.expiresAt,
    };
}
//# sourceMappingURL=invite.service.js.map