import bcrypt from "bcrypt";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { $Enums, Prisma } from "../../../generated/prisma/client.js";
import type { AccountGetPayload } from "../../../generated/prisma/models/Account.js";
import { AppError } from "../../lib/AppError.js";
import { PERMISSIONS } from "../../lib/permissions.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { subdomainCandidates, slugify } from "../../lib/slugs.js";
import { isReservedSubdomain } from "../../lib/reservedSubdomains.js";
import { env, googleRedirectUris } from "../../config/env.js";
import type { GoogleOAuthClient } from "./google.js";
import {
  formatRefreshToken,
  generateRefreshTokenSecret,
  parseRefreshToken,
  refreshTokenLifetimeMs,
  signAccessToken,
} from "../../lib/tokens.js";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  googleSignInSchema,
  loginSchema,
  pinLoginSchema,
  setPinSchema,
  onboardingSchema,
  refreshTokenSchema,
  registerSchema,
  resetPasswordSchema,
  validateOrThrow,
  verifyEmailSchema,
  verifyPasswordResetOtpSchema,
  type ChangePasswordInput,
  type GoogleSignInInput,
  type LoginInput,
  type OnboardingInput,
  type RegisterInput,
} from "./schemas.js";
import { resolveOnboardingTemplateId } from "../templates/service.js";

export type AuthRole = "OWNER" | $Enums.StaffRole;

/** Verification email payload and outbound channel (mirrors the staff-invite contract). */
export interface VerificationEmailData {
  to: string;
  code: string;
  expiresAt: Date;
}

/** Outbound verification email channel; implemented by the console stub and Resend. */
export interface VerificationEmailSender {
  sendVerificationEmail(data: VerificationEmailData): Promise<void>;
}

export interface PasswordResetEmailData {
  to: string;
  code: string;
  expiresAt: Date;
}

export interface PasswordResetEmailSender {
  sendPasswordResetEmail(data: PasswordResetEmailData): Promise<void>;
}

/** Welcome email payload: the freshly-onboarded owner and their store. */
export interface WelcomeEmailData {
  to: string;
  storeName: string;
}

/** Outbound welcome email channel; implemented by the console stub and Resend. */
export interface WelcomeEmailSender {
  sendWelcomeEmail(data: WelcomeEmailData): Promise<void>;
}

const OTP_TTL_MS = env.OTP_TTL_MINUTES * 60_000;
const OTP_COOLDOWN_MS = env.OTP_RESEND_COOLDOWN_SECONDS * 1000;
const OTP_WINDOW_MS = env.OTP_REQUEST_WINDOW_MINUTES * 60_000;
const OTP_MAX_ATTEMPTS = env.OTP_MAX_ATTEMPTS;
const OTP_MAX_REQUESTS = env.OTP_MAX_REQUESTS_PER_WINDOW;
const RESET_GRANT_TTL_MS = 10 * 60_000;

export type OtpPurpose = $Enums.OtpPurpose;

/** Six-digit uniformly random OTP. Leading zeroes are deliberately retained. */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function hashOtpCode(
  accountId: string,
  purpose: OtpPurpose,
  destination: string,
  code: string,
): string {
  return createHmac("sha256", env.OTP_HMAC_SECRET)
    .update(`${purpose}\0${accountId}\0${destination}\0${code}`)
    .digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === 32 && rightBuffer.length === 32 && timingSafeEqual(leftBuffer, rightBuffer);
}

function invalidOtpError(): AppError {
  return new AppError(400, "OTP_INVALID", "The code is invalid or expired. Request a new code.");
}

/**
 * The user object returned by register, login, onboarding, and (extended
 * with permissions) /me. Tenant fields and role are null until the
 * account completes onboarding (Store + Owner creation); needOnboarding
 * is the client's signal to run the onboarding flow; verified reflects
 * whether the account proved ownership of its email (set once via
 * verifyEmail, required before onboarding).
 */
export interface AuthUserInfo {
  accountId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  role: AuthRole | null;
  storeId: string | null;
  storeName: string | null;
  subdomain: string | null;
  needsOnboarding: boolean;
  verified: boolean;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: AuthUserInfo;
}

export interface MeResult extends AuthUserInfo {
  permissions: string[];
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
}

type AccountWithMemberships = AccountGetPayload<{
  include: {
    owner: { include: { store: true } };
    staffMembers: { include: { store: true } };
  };
}>;

interface Membership {
  role: AuthRole;
  storeId: string;
  storeName: string;
  subdomain: string | null;
  staffMemberId?: string;
  permissions?: string[];
  isActive: boolean;
}

/** Maps an account row to the client-facing user object. */
function userInfo(account: AccountWithMemberships): AuthUserInfo {
  const membership = resolveMembership(account);
  return {
    accountId: account.id,
    email: account.email,
    firstName: account.firstName,
    lastName: account.lastName,
    phone: account.phone,
    role: membership?.role ?? null,
    storeId: membership?.storeId ?? null,
    storeName: membership?.storeName ?? null,
    subdomain: membership?.subdomain ?? null,
    needsOnboarding: membership === null,
    verified: account.emailVerifiedAt !== null,
  };
}

/** Password/token-hash cost. 12 is the production-grade default. */
export const BCRYPT_COST = 12;

/**
 * Resolves an account's tenant membership. The Owner record wins over
 * StaffMember when an account holds both; accounts with neither have no
 * tenant context and cannot authenticate.
 */
function resolveMembership(account: AccountWithMemberships): Membership | null {
  const owner = account.owner;
  if (owner !== null) {
    return {
      role: "OWNER",
      storeId: owner.storeId,
      storeName: owner.store.name,
      subdomain: owner.store.subdomain,
      permissions: [...PERMISSIONS],
      isActive: true,
    };
  }
  const staffMember = account.staffMembers[0];
  if (staffMember !== undefined) {
    return {
      role: staffMember.role,
      storeId: staffMember.storeId,
      storeName: staffMember.store.name,
      subdomain: staffMember.store.subdomain,
      staffMemberId: staffMember.id,
      permissions: staffMember.permissions,
      isActive: staffMember.isActive,
    };
  }
  return null;
}

/** True when a Prisma P2002 unique-violation targets the given column. */
function isUniqueViolation(err: unknown, field: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, meta } = err as { code?: unknown; meta?: unknown };
  if (code !== "P2002") return false;

  // The standard shape puts the constrained column(s) in meta.target.
  // Prisma 7 + driver adapters instead report
  // meta.driverAdapterError.cause.constraint.fields (or .constraint as a
  // raw constraint name like "Account_email_key"). Collect every
  // candidate from both shapes and match any of them.
  const candidates: string[] = [];
  const rawMeta = meta as {
    target?: unknown;
    driverAdapterError?: { cause?: { constraint?: unknown } };
  };
  const target = rawMeta.target;
  if (Array.isArray(target)) {
    candidates.push(...target.map(String));
  } else if (typeof target === "string" || typeof target === "object") {
    const column =
      typeof target === "object" && target !== null && "column" in target
        ? (target as { column?: unknown }).column
        : target;
    if (typeof column === "string") candidates.push(column);
  }
  const constraint = rawMeta.driverAdapterError?.cause?.constraint;
  if (typeof constraint === "string") {
    candidates.push(constraint);
  } else if (typeof constraint === "object" && constraint !== null) {
    const fields = (constraint as { fields?: unknown }).fields;
    if (Array.isArray(fields)) candidates.push(...fields.map(String));
  }

  return candidates.includes(field) || candidates.some((c) => c.endsWith(`_${field}_key`));
}

/** Creates a refresh-token row (hashed secret) and returns the raw token. */
export async function issueRefreshToken(accountId: string): Promise<string> {
  const secret = generateRefreshTokenSecret();
  const tokenHash = await bcrypt.hash(secret, BCRYPT_COST);
  const row = await getPrismaClient().refreshToken.create({
    data: {
      accountId,
      tokenHash,
      expiresAt: new Date(Date.now() + refreshTokenLifetimeMs()),
    },
  });
  return formatRefreshToken(row.id, secret);
}

/** Revokes every active refresh token for the account; returns the count. */
export async function revokeAllRefreshTokens(accountId: string): Promise<number> {
  const result = await getPrismaClient().refreshToken.updateMany({
    where: { accountId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/**
 * Creates a single-use verification token row and returns the raw token
 * (the only place the raw value exists — it is not hashed at rest,
 * mirroring the invite-token pattern where the token itself is the
 * credential presented via email link).
 */
interface IssuedOtp {
  challengeId: string;
  code: string;
  expiresAt: Date;
}

/** Issue under an account row lock so concurrent requests cannot race rotation or quotas. */
async function issueOtp(
  accountId: string,
  purpose: OtpPurpose,
  destination: string,
): Promise<IssuedOtp> {
  const prisma = getPrismaClient();
  const normalizedDestination = destination.trim().toLowerCase();
  const now = new Date();
  const code = generateOtpCode();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  const codeHash = hashOtpCode(accountId, purpose, normalizedDestination, code);

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Account" WHERE "id" = ${accountId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");

    const latest = await tx.otpChallenge.findFirst({
      where: { accountId, purpose, destination: normalizedDestination },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    });
    if (latest !== null && latest.createdAt.getTime() > now.getTime() - OTP_COOLDOWN_MS) {
      throw new AppError(429, "RATE_LIMITED", "Please wait before requesting another code");
    }

    const requestCount = await tx.otpChallenge.count({
      where: {
        accountId,
        purpose,
        destination: normalizedDestination,
        createdAt: { gte: new Date(now.getTime() - OTP_WINDOW_MS) },
      },
    });
    if (requestCount >= OTP_MAX_REQUESTS) {
      throw new AppError(429, "RATE_LIMITED", "Code request limit reached; try again later");
    }

    await tx.otpChallenge.updateMany({
      where: {
        accountId,
        purpose,
        destination: normalizedDestination,
        usedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: now },
    });
    const challenge = await tx.otpChallenge.create({
      data: {
        accountId,
        purpose,
        destination: normalizedDestination,
        codeHash,
        expiresAt,
      },
      select: { id: true },
    });
    return { challengeId: challenge.id, code, expiresAt };
  });
}

async function invalidateOtp(challengeId: string): Promise<void> {
  await getPrismaClient().otpChallenge.updateMany({
    where: { id: challengeId, usedAt: null, invalidatedAt: null },
    data: { invalidatedAt: new Date() },
  });
}

/**
 * Best-effort verification email delivery: a send failure is logged and
 * swallowed — registration/resend must never fail because mail did (the
 * user can always request a resend). Mirror of the invite pattern.
 */
async function sendVerificationEmailBestEffort(
  sender: VerificationEmailSender,
  data: VerificationEmailData,
  challengeId: string,
): Promise<void> {
  try {
    await sender.sendVerificationEmail(data);
  } catch (err) {
    void err;
    console.error("[verify-email] code delivery failed");
    await invalidateOtp(challengeId);
  }
}

/**
 * Best-effort welcome email delivery: a send failure is logged and
 * swallowed — onboarding must never fail because mail did. Same rule as
 * the verification and invite channels.
 */
async function sendWelcomeEmailBestEffort(
  sender: WelcomeEmailSender,
  data: WelcomeEmailData,
): Promise<void> {
  try {
    await sender.sendWelcomeEmail(data);
  } catch (err) {
    console.error(
      `[welcome-email] failed to send welcome email to ${data.to}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Registers a new account with personal details only — no store, no
 * subdomain. The Account is created alone; Store + Owner are created by
 * onboardAccount() so a first-time user never faces tenant choices at
 * signup. The account is logged in immediately (needsOnboarding: true)
 * and a single-use email-verification token is issued and mailed
 * best-effort — the account cannot onboard until the email is verified.
 */
export async function register(
  input: unknown,
  sender: VerificationEmailSender,
): Promise<AuthResult> {
  const data = validateOrThrow(registerSchema, input) as RegisterInput;
  const prisma = getPrismaClient();
  const passwordHash = await bcrypt.hash(data.password, BCRYPT_COST);

  let account: { id: string; email: string };
  try {
    account = await prisma.account.create({
      data: {
        email: data.email,
        passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err, "email")) {
      throw new AppError(409, "EMAIL_TAKEN", "An account with that email already exists");
    }
    throw err;
  }

  const { challengeId, code, expiresAt } = await issueOtp(
    account.id,
    "EMAIL_VERIFICATION",
    account.email,
  );
  await sendVerificationEmailBestEffort(sender, {
    to: account.email,
    code,
    expiresAt,
  }, challengeId);

  const refreshToken = await issueRefreshToken(account.id);
  const accessToken = signAccessToken({ sub: account.id, role: "" });
  return {
    accessToken,
    refreshToken,
    user: {
      accountId: account.id,
      email: account.email,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
      role: null,
      storeId: null,
      storeName: null,
      subdomain: null,
      needsOnboarding: true,
      verified: false,
    },
  };
}

/**
 * Verify and consume a challenge under the account lock. Every issuance and
 * verification uses this lock order, serializing resend, attempts, and OTP
 * consumption without allowing concurrent requests to exceed the attempt cap.
 */
async function consumeOtp<T>(
  rawEmail: string,
  code: string,
  purpose: OtpPurpose,
  onConsumed: (tx: Prisma.TransactionClient, accountId: string, now: Date) => Promise<T>,
): Promise<T> {
  const email = rawEmail.trim().toLowerCase();
  const prisma = getPrismaClient();
  const account = await prisma.account.findUnique({
    where: { email },
    select: { id: true },
  });
  if (account === null) throw invalidOtpError();

  const result = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Account" WHERE "id" = ${account.id}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return { success: false as const };

    const challenge = await tx.otpChallenge.findFirst({
      where: {
        accountId: account.id,
        purpose,
        destination: email,
        usedAt: null,
        invalidatedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });
    if (
      challenge === null ||
      challenge.expiresAt.getTime() <= now.getTime() ||
      challenge.attempts >= OTP_MAX_ATTEMPTS
    ) {
      return { success: false as const };
    }

    const submittedHash = hashOtpCode(account.id, purpose, email, code);
    if (!sameDigest(challenge.codeHash, submittedHash)) {
      const attempts = challenge.attempts + 1;
      await tx.otpChallenge.updateMany({
        where: {
          id: challenge.id,
          attempts: challenge.attempts,
          usedAt: null,
          invalidatedAt: null,
          expiresAt: { gt: now },
        },
        data: {
          attempts,
          ...(attempts >= OTP_MAX_ATTEMPTS ? { invalidatedAt: now } : {}),
        },
      });
      return { success: false as const };
    }

    const claimed = await tx.otpChallenge.updateMany({
      where: {
        id: challenge.id,
        attempts: { lt: OTP_MAX_ATTEMPTS },
        usedAt: null,
        invalidatedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return { success: false as const };
    return { success: true as const, value: await onConsumed(tx, account.id, now) };
  });

  if (!result.success) throw invalidOtpError();
  return result.value;
}

export async function verifyEmail(rawInput: unknown): Promise<{ verified: true }> {
  const { email, code } = validateOrThrow(verifyEmailSchema, rawInput);
  return consumeOtp(email, code, "EMAIL_VERIFICATION", async (tx, accountId, now) => {
    await tx.account.update({ where: { id: accountId }, data: { emailVerifiedAt: now } });
    return { verified: true as const };
  });
}

function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Always returns the same result for a valid email, whether the account exists or not. */
export async function requestPasswordReset(
  rawInput: unknown,
  sender: PasswordResetEmailSender,
): Promise<{ accepted: true }> {
  const { email } = validateOrThrow(forgotPasswordSchema, rawInput);
  const prisma = getPrismaClient();
  const account = await prisma.account.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (account === null) return { accepted: true };

  let challenge: IssuedOtp;
  try {
    challenge = await issueOtp(account.id, "PASSWORD_RESET", account.email);
  } catch (err) {
    // Keep account-level cooldown/quota results indistinguishable from an
    // unknown address. The route's IP limiter still returns a generic 429.
    if (err instanceof AppError && err.statusCode === 429) return { accepted: true };
    throw err;
  }

  try {
    await sender.sendPasswordResetEmail({
      to: account.email,
      code: challenge.code,
      expiresAt: challenge.expiresAt,
    });
  } catch {
    console.error("[password-reset] code delivery failed");
    await invalidateOtp(challenge.challengeId);
  }
  return { accepted: true };
}

/** Consume a reset OTP and issue a separate, short-lived reset grant. */
export async function verifyPasswordResetOtp(rawInput: unknown): Promise<{ resetToken: string }> {
  const { email, code } = validateOrThrow(verifyPasswordResetOtpSchema, rawInput);
  const resetToken = `rst_${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashPasswordResetToken(resetToken);
  return consumeOtp(email, code, "PASSWORD_RESET", async (tx, accountId, now) => {
    await tx.passwordResetToken.updateMany({
      where: { accountId, usedAt: null },
      data: { usedAt: now },
    });
    await tx.passwordResetToken.create({
      data: {
        accountId,
        tokenHash,
        expiresAt: new Date(now.getTime() + RESET_GRANT_TTL_MS),
      },
    });
    return { resetToken };
  });
}

/**
 * Consumes a short-lived reset grant exactly once, changes the password,
 * invalidates every other grant, and revokes all refresh sessions atomically.
 */
export async function resetPassword(rawInput: unknown): Promise<void> {
  const { resetToken: resetTokenValue, newPassword } = validateOrThrow(resetPasswordSchema, rawInput);
  const prisma = getPrismaClient();
  const tokenHash = hashPasswordResetToken(resetTokenValue);
  const resetGrant = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  const now = new Date();
  if (
    resetGrant === null ||
    resetGrant.usedAt !== null ||
    resetGrant.expiresAt.getTime() <= now.getTime()
  ) {
    throw new AppError(
      400,
      "PASSWORD_RESET_INVALID",
      "This password reset session is invalid or has expired. Request a new code.",
    );
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  const consumed = await prisma.$transaction(async (tx) => {
    const claim = await tx.passwordResetToken.updateMany({
      where: { id: resetGrant.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claim.count !== 1) return false;

    await tx.account.update({
      where: { id: resetGrant.accountId },
      data: { passwordHash },
    });
    await tx.refreshToken.updateMany({
      where: { accountId: resetGrant.accountId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.passwordResetToken.updateMany({
      where: { accountId: resetGrant.accountId, usedAt: null },
      data: { usedAt: now },
    });
    return true;
  });

  if (!consumed) {
    throw new AppError(
      400,
      "PASSWORD_RESET_INVALID",
      "This password reset session is invalid or has expired. Request a new code.",
    );
  }
}

/** Issues a fresh email-verification OTP, rotating the prior challenge. */
export async function resendVerification(
  accountId: string,
  sender: VerificationEmailSender,
): Promise<{ sent: true }> {
  const prisma = getPrismaClient();

  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (account === null) {
    throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
  }
  if (account.emailVerifiedAt !== null) {
    throw new AppError(409, "ALREADY_VERIFIED", "Email is already verified — you can sign in now");
  }

  const challenge = await issueOtp(accountId, "EMAIL_VERIFICATION", account.email);
  await sendVerificationEmailBestEffort(sender, {
    to: account.email,
    code: challenge.code,
    expiresAt: challenge.expiresAt,
  }, challenge.challengeId);
  return { sent: true };
}

/**
 * Creates the account's Store and Owner in a single transaction — the
 * onboarding step after register. Once-only per account: an account that
 * already owns a store gets ALREADY_ONBOARDED. The email must be
 * verified first (VERIFICATION_REQUIRED); verification is the only
 * thing onboarding gates on — sessions, /me, and /auth/refresh all work
 * before it. No token rotation is needed: access-token claims are
 * convenience only, tenant resolution is database-backed.
 */
export async function onboardAccount(
  accountId: string,
  input: unknown,
  welcomeSender?: WelcomeEmailSender,
): Promise<AuthUserInfo> {
  const data = validateOrThrow(onboardingSchema, input) as OnboardingInput;
  const prisma = getPrismaClient();

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: {
      owner: { include: { store: true } },
      staffMembers: { include: { store: true } },
    },
  });
  if (account === null) {
    throw new AppError(
      401,
      "ACCOUNT_MISSING",
      "Your account no longer exists — please contact support",
    );
  }
  if (account.emailVerifiedAt === null) {
    throw new AppError(
      403,
      "VERIFICATION_REQUIRED",
      "Please verify your email before setting up your store — check your inbox for the verification link",
    );
  }

  // The subdomain is derived from the store name, so a name that maps to
  // a reserved subdomain (e.g. "Brikoh") or is too short to produce a
  // valid one is rejected up front — the client gets a clear error
  // instead of a silently different subdomain.
  const baseSlug = slugify(data.name);
  if (baseSlug !== null && isReservedSubdomain(baseSlug)) {
    throw new AppError(
      409,
      "SUBDOMAIN_RESERVED",
      "That store name isn't available — please choose a different one.",
    );
  }
  if (baseSlug === null) {
    throw new AppError(
      409,
      "SUBDOMAIN_TOO_SHORT",
      "Please choose a store name with at least 4 letters or numbers.",
    );
  }

  // The storefront template choice is resolved BEFORE the transaction
  // loop so an invalid pick fails fast (400 TEMPLATE_NOT_AVAILABLE, no
  // retries). Pre-onboarding the account has no store, hence no
  // subscription: the visible set is the pre-subscription STARTER set.
  const templateId = await resolveOnboardingTemplateId(data.templateId);

  let store: { id: string; name: string; subdomain: string | null } | undefined;
  // The subdomain is derived from the store name, never accepted from
  // the client. The candidate list is ordered (base slug, numeric
  // suffixes, random fallbacks); the first free one wins. A concurrent
  // registration may claim a candidate between our check and the
  // create — the unique violation just advances to the next candidate.
  const candidates = subdomainCandidates(data.name);
  for (const candidate of candidates) {
    try {
      store = await prisma.$transaction(async (tx) => {
        const existingOwner = await tx.owner.findUnique({ where: { accountId } });
        if (existingOwner !== null) {
          throw new AppError(
            409,
            "ALREADY_ONBOARDED",
            "This account already has a store — you can sign in directly",
          );
        }
        const createdStore = await tx.store.create({
          data: {
            name: data.name,
            subdomain: candidate,
            businessType: data.businessType,
            location: data.location,
            currency: data.currency,
            businessPhone: data.businessPhone,
            templateId,
          },
        });
        // Every store starts with one "Main Branch" — the store's primary
        // physical point — which is also its default branch (the branch
        // public checkout and staff sales resolve against). The branches
        // migration backfills this for pre-existing stores; new stores
        // get it here, atomically with the store row.
        const mainBranch = await tx.branch.create({
          data: {
            storeId: createdStore.id,
            name: "Main Branch",
            address: data.location,
          },
        });
        await tx.store.update({
          where: { id: createdStore.id },
          data: { defaultBranchId: mainBranch.id },
        });
        await tx.owner.create({ data: { accountId, storeId: createdStore.id } });
        return createdStore;
      });
      break;
    } catch (err) {
      // A concurrent registration claimed this candidate — try the next.
      if (isUniqueViolation(err, "subdomain")) continue;
      if (isUniqueViolation(err, "accountId")) {
        throw new AppError(
          409,
          "ALREADY_ONBOARDED",
          "This account already has a store — you can sign in directly",
        );
      }
      if (err instanceof AppError) throw err;
      throw err;
    }
  }
  if (store === undefined) {
    // Practically unreachable — the random fallbacks make exhaustion
    // near-impossible — but the client still deserves a clean error.
    throw new AppError(
      409,
      "SUBDOMAIN_TAKEN",
      "Couldn't find an available subdomain — please try a different store name",
    );
  }

  // The store is live: welcome the new owner (best-effort, so a mail
  // failure can never fail the request).
  if (welcomeSender !== undefined) {
    await sendWelcomeEmailBestEffort(welcomeSender, { to: account.email, storeName: store.name });
  }

  return {
    accountId: account.id,
    email: account.email,
    firstName: account.firstName,
    lastName: account.lastName,
    phone: account.phone,
    role: "OWNER",
    storeId: store.id,
    storeName: store.name,
    subdomain: store.subdomain,
    needsOnboarding: false,
    verified: true,
  };
}

/**
 * Authenticates an account. Unknown email and wrong password produce the
 * identical INVALID_CREDENTIALS response. A validly credentialed account
 * without a tenant (registered, not onboarded) logs in successfully with
 * needsOnboarding: true — login never rejects for a missing store.
 */
export async function login(input: unknown): Promise<AuthResult> {
  const data = validateOrThrow(loginSchema, input) as LoginInput;
  const prisma = getPrismaClient();

  const account = await prisma.account.findUnique({
    where: { email: data.email },
    include: {
      owner: { include: { store: true } },
      staffMembers: { include: { store: true } },
    },
  });
  if (account === null) {
    throw new AppError(
      401,
      "INVALID_CREDENTIALS",
      "Email or password is incorrect — please try again",
    );
  }

  // Google-native accounts have no password (passwordHash is null); the
  // response stays identical to the unknown-email case so the endpoint
  // never reveals which emails exist or how an account was created.
  const passwordOk =
    account.passwordHash !== null && (await bcrypt.compare(data.password, account.passwordHash));
  if (!passwordOk) {
    throw new AppError(
      401,
      "INVALID_CREDENTIALS",
      "Email or password is incorrect — please try again",
    );
  }

  const membership = resolveMembership(account);
  // A deactivated staff member cannot sign in — their sessions were
  // revoked at deactivation and must not be resurrected by a fresh
  // login. Owners are always active.
  if (membership !== null && membership.isActive === false) {
    throw new AppError(
      403,
      "ACCOUNT_DISABLED",
      "This account has been deactivated — contact your store owner",
    );
  }
  const refreshToken = await issueRefreshToken(account.id);
  const accessToken = signAccessToken({
    sub: account.id,
    storeId: membership?.storeId,
    role: membership?.role ?? "",
    staffMemberId: membership?.staffMemberId,
  });
  return {
    accessToken,
    refreshToken,
    user: userInfo(account),
  };
}

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60_000;

/** PIN sign-in is intended for a user's own mobile device; password remains the recovery credential. */
export async function loginWithPin(input: unknown): Promise<AuthResult> {
  const data = validateOrThrow(pinLoginSchema, input);
  const prisma = getPrismaClient();
  const account = await prisma.account.findUnique({
    where: { email: data.email },
    include: { owner: { include: { store: true } }, staffMembers: { include: { store: true } }, pinCredential: true },
  });
  const credential = account?.pinCredential;
  const invalid = () => new AppError(401, "INVALID_CREDENTIALS", "Email or PIN is incorrect — please try again");
  if (!account || !credential) throw invalid();
  const now = new Date();
  if (credential.lockedUntil && credential.lockedUntil > now) {
    throw new AppError(429, "PIN_TEMPORARILY_LOCKED", "PIN sign-in is temporarily locked. Use your account password or try again later.");
  }
  if (!(await bcrypt.compare(data.pin, credential.pinHash))) {
    const locked = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "accountId" FROM "AccountPinCredential" WHERE "accountId" = ${account.id}::uuid FOR UPDATE`;
      const latest = await tx.accountPinCredential.findUnique({ where: { accountId: account.id } });
      if (!latest || (latest.lockedUntil && latest.lockedUntil > new Date())) return true;
      const attempts = latest.failedAttempts + 1;
      if (attempts >= PIN_MAX_ATTEMPTS) {
        await tx.accountPinCredential.update({ where: { accountId: account.id }, data: { failedAttempts: 0, lockedUntil: new Date(Date.now() + PIN_LOCK_MS) } });
        return true;
      }
      await tx.accountPinCredential.update({ where: { accountId: account.id }, data: { failedAttempts: attempts } });
      return false;
    });
    if (locked) throw new AppError(429, "PIN_TEMPORARILY_LOCKED", "Too many incorrect PIN attempts. Use your account password or try again in 15 minutes.");
    throw invalid();
  }
  const membership = resolveMembership(account);
  if (membership && !membership.isActive) throw new AppError(403, "ACCOUNT_DISABLED", "This account has been deactivated — contact your store owner");
  const stillUnlocked = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "accountId" FROM "AccountPinCredential" WHERE "accountId" = ${account.id}::uuid FOR UPDATE`;
    const latest = await tx.accountPinCredential.findUnique({ where: { accountId: account.id } });
    if (!latest || (latest.lockedUntil && latest.lockedUntil > new Date())) return false;
    await tx.accountPinCredential.update({ where: { accountId: account.id }, data: { failedAttempts: 0, lockedUntil: null } });
    return true;
  });
  if (!stillUnlocked) throw new AppError(429, "PIN_TEMPORARILY_LOCKED", "PIN sign-in is temporarily locked. Use your account password or try again later.");
  const refreshToken = await issueRefreshToken(account.id);
  const accessToken = signAccessToken({ sub: account.id, storeId: membership?.storeId, role: membership?.role ?? "", staffMemberId: membership?.staffMemberId });
  return { accessToken, refreshToken, user: userInfo(account) };
}

/** Initial setup requires a fresh authenticated session; replacing a PIN requires the account password. */
export async function setAccountPin(accountId: string, input: unknown): Promise<void> {
  const data = validateOrThrow(setPinSchema, input);
  const prisma = getPrismaClient();
  const account = await prisma.account.findUnique({ where: { id: accountId }, include: { pinCredential: true } });
  if (!account) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
  if (account.pinCredential) {
    const valid = account.passwordHash && data.currentPassword && await bcrypt.compare(data.currentPassword, account.passwordHash);
    if (!valid) throw new AppError(401, "INVALID_CREDENTIALS", "Enter your account password to change your PIN");
  }
  const pinHash = await bcrypt.hash(data.pin, BCRYPT_COST);
  await prisma.accountPinCredential.upsert({ where: { accountId }, create: { accountId, pinHash }, update: { pinHash, failedAttempts: 0, lockedUntil: null } });
}

export async function getAccountPinStatus(accountId: string): Promise<{ configured: boolean }> {
  const credential = await getPrismaClient().accountPinCredential.findUnique({ where: { accountId }, select: { id: true } });
  return { configured: credential !== null };
}

/**
 * The member lookup every sign-in resolves against. Owner wins over
 * staff (matching login); accounts with neither have no tenant context
 * and report needsOnboarding: true.
 */
function accountMemberships() {
  return {
    owner: { include: { store: true } },
    staffMembers: { include: { store: true } },
  };
}

async function fetchAccount(
  prisma: ReturnType<typeof getPrismaClient>,
  where: { email: string } | { googleSub: string },
) {
  return prisma.account.findUnique({ where, include: accountMemberships() });
}

/**
 * Signs an account in with a Google authorization code. The code is
 * exchanged server-side (client secret) and the verified identity is
 * matched by googleSub, then by email:
 *
 * - Found — sign in; link googleSub if the account was created another
 *   way (password registration or invite).
 * - Not found — create a Google-native account (no password, email
 *   pre-verified by Google) and return it for onboarding.
 *
 * Concurrent sign-ins / registrations for the same Google identity or
 * email resolve to one account via the unique constraints.
 */
export async function googleSignIn(client: GoogleOAuthClient, input: unknown): Promise<AuthResult> {
  const data = validateOrThrow(googleSignInSchema, input) as GoogleSignInInput;
  const isLocalhostRedirect = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/.*$/.test(
    data.redirectUri,
  );
  if (!googleRedirectUris(env).includes(data.redirectUri) && !isLocalhostRedirect) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "This redirect URL is not allowed — please use the correct callback URL",
    );
  }
  const profile = await client.exchangeCode(data.code, data.redirectUri);
  const prisma = getPrismaClient();

  let account: AccountWithMemberships | null = await fetchAccount(prisma, {
    googleSub: profile.sub,
  });
  if (account === null) {
    account = await fetchAccount(prisma, { email: profile.email });
  }

  if (account === null) {
    try {
      account = await prisma.account.create({
        data: {
          email: profile.email,
          googleSub: profile.sub,
          firstName: profile.firstName,
          lastName: profile.lastName,
          // Google verified the email — the account skips the separate
          // verification step and can onboard immediately.
          emailVerifiedAt: new Date(),
        },
        include: accountMemberships(),
      });
    } catch (err) {
      // A concurrent sign-in created or claimed this identity — resolve
      // to the winner instead of surfacing the unique violation.
      if (!isUniqueViolation(err, "email") && !isUniqueViolation(err, "googleSub")) {
        throw err;
      }
      account =
        (await fetchAccount(prisma, { googleSub: profile.sub })) ??
        (await fetchAccount(prisma, { email: profile.email }));
      if (account === null) throw err;
    }
  }

  // Link the Google identity to an account that was created another way.
  if (account.googleSub === null) {
    try {
      account = await prisma.account.update({
        where: { id: account.id },
        data: { googleSub: profile.sub },
        include: accountMemberships(),
      });
    } catch (err) {
      if (!isUniqueViolation(err, "googleSub")) throw err;
      account = await fetchAccount(prisma, { googleSub: profile.sub });
      if (account === null) throw err;
    }
  }

  const membership = resolveMembership(account);
  // A deactivated staff member cannot sign in — Google does not bypass
  // the same guard password login enforces.
  if (membership !== null && membership.isActive === false) {
    throw new AppError(
      403,
      "ACCOUNT_DISABLED",
      "This account has been deactivated — contact your store owner",
    );
  }
  const refreshToken = await issueRefreshToken(account.id);
  const accessToken = signAccessToken({
    sub: account.id,
    storeId: membership?.storeId,
    role: membership?.role ?? "",
    staffMemberId: membership?.staffMemberId,
  });
  return {
    accessToken,
    refreshToken,
    user: userInfo(account),
  };
}

/**
 * Rotates a refresh token: the presented token is revoked and a new
 * pair issued. Presenting an already-revoked token (or a valid row with
 * the wrong secret) is treated as possible theft: every other active
 * refresh token for the account is revoked and the request is rejected.
 * The atomic updateMany makes concurrent refreshes safe — exactly one
 * wins, the loser is rejected as reused.
 */
export async function refresh(rawRefreshToken: unknown): Promise<RefreshResult> {
  const token = validateOrThrow(refreshTokenSchema, rawRefreshToken);
  const parsed = parseRefreshToken(token);
  if (parsed === null) {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Invalid session — please log in again");
  }
  const prisma = getPrismaClient();

  const row = await prisma.refreshToken.findUnique({ where: { id: parsed.tokenId } });
  if (row === null) {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Invalid session — please log in again");
  }
  if (row.revokedAt !== null) {
    await revokeAllRefreshTokens(row.accountId);
    throw new AppError(
      401,
      "TOKEN_REUSE_DETECTED",
      "This session was already used — all your sessions have been logged out for security",
    );
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new AppError(401, "SESSION_EXPIRED", "Your session has expired — please log in again");
  }

  const secretOk = await bcrypt.compare(parsed.secret, row.tokenHash);
  if (!secretOk) {
    await revokeAllRefreshTokens(row.accountId);
    throw new AppError(
      401,
      "TOKEN_REUSE_DETECTED",
      "Session verification failed — all your sessions have been logged out for security",
    );
  }

  const account = await prisma.account.findUnique({
    where: { id: row.accountId },
    include: {
      owner: { include: { store: true } },
      staffMembers: { include: { store: true } },
    },
  });
  if (account === null) {
    throw new AppError(
      401,
      "ACCOUNT_MISSING",
      "Your account no longer exists — please contact support",
    );
  }
  const membership = resolveMembership(account);
  if (membership !== null && membership.isActive === false) {
    await revokeAllRefreshTokens(row.accountId);
    throw new AppError(
      403,
      "ACCOUNT_DISABLED",
      "This account has been deactivated — contact your store owner",
    );
  }

  const rotated = await prisma.refreshToken.updateMany({
    where: { id: row.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (rotated.count === 0) {
    // Lost the rotation race: the token was already used by a concurrent
    // request. Same reuse signal as presenting an already-revoked token —
    // every other session is revoked.
    await revokeAllRefreshTokens(row.accountId);
    throw new AppError(
      401,
      "TOKEN_REUSE_DETECTED",
      "This session was already used — please log in again",
    );
  }

  const newRefreshToken = await issueRefreshToken(row.accountId);
  const accessToken = signAccessToken({
    sub: row.accountId,
    storeId: membership?.storeId,
    role: membership?.role ?? "",
    staffMemberId: membership?.staffMemberId,
  });
  return { accessToken, refreshToken: newRefreshToken };
}

/**
 * Revokes the presented refresh token. Idempotent: already-revoked or
 * unknown tokens resolve successfully, so logout always leaves the
 * client signed out.
 */
export async function logout(rawRefreshToken: unknown): Promise<void> {
  const token = validateOrThrow(refreshTokenSchema, rawRefreshToken);
  const parsed = parseRefreshToken(token);
  if (parsed === null) {
    throw new AppError(400, "VALIDATION_ERROR", "Malformed refresh token");
  }
  const prisma = getPrismaClient();
  const row = await prisma.refreshToken.findUnique({ where: { id: parsed.tokenId } });
  if (row === null || row.revokedAt !== null) return;
  await prisma.refreshToken.updateMany({
    where: { id: row.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Changes the account password and revokes every active refresh token,
 * logging all other sessions out. The caller must prove knowledge of the
 * current password (INVALID_CREDENTIALS otherwise).
 */
export async function changePassword(accountId: string, rawInput: unknown): Promise<void> {
  const { currentPassword, newPassword } = validateOrThrow(
    changePasswordSchema,
    rawInput,
  ) as ChangePasswordInput;
  const prisma = getPrismaClient();

  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (account === null) {
    throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
  }
  const currentOk =
    account.passwordHash !== null && (await bcrypt.compare(currentPassword, account.passwordHash));
  if (!currentOk) {
    throw new AppError(
      401,
      "INVALID_CREDENTIALS",
      "Current password is incorrect — please try again",
    );
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await prisma.account.update({ where: { id: accountId }, data: { passwordHash } });
  await revokeAllRefreshTokens(accountId);
}

/**
 * Deletes invite tokens that expired while still PENDING. Accepted
 * invites are historical record and are never touched. Safe to call
 * repeatedly; returns the number of rows deleted.
 */
export async function deleteExpiredInviteTokens(): Promise<{ count: number }> {
  const result = await getPrismaClient().inviteToken.deleteMany({
    where: { status: "PENDING", expiresAt: { lt: new Date() } },
  });
  return { count: result.count };
}

/**
 * Deletes verification tokens that are spent (used) or past expiry.
 * Unlike invite rows they carry no historical value — verification is
 * a one-way state transition recorded on the Account. Safe to call
 * repeatedly; returns the number of rows deleted.
 */
export async function deleteExpiredOtpChallenges(retentionDays = 90): Promise<{ count: number }> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const result = await getPrismaClient().otpChallenge.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [
        { expiresAt: { lt: now } },
        { usedAt: { not: null } },
        { invalidatedAt: { not: null } },
      ],
    },
  });
  return { count: result.count };
}

/** Backwards-named compatibility wrapper for callers during the link-to-OTP migration. */
export async function deleteExpiredVerificationTokens(): Promise<{ count: number }> {
  return deleteExpiredOtpChallenges();
}

export async function deleteExpiredPasswordResetGrants(retentionDays = 90): Promise<{ count: number }> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const result = await getPrismaClient().passwordResetToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: cutoff } }] },
  });
  return { count: result.count };
}

/** Periodically removes spent OTP/grant rows after the audit retention period. */
export function startAuthOtpCleanup(): void {
  if (env.NODE_ENV === "test") return;
  const run = async () => {
    try {
      const [otps, grants] = await Promise.all([
        deleteExpiredOtpChallenges(),
        deleteExpiredPasswordResetGrants(),
      ]);
      if (otps.count + grants.count > 0) console.info("[auth] expired OTP data cleaned");
    } catch {
      console.error("[auth] OTP cleanup failed");
    }
  };
  void run();
  const timer = setInterval(() => void run(), env.OTP_CLEANUP_INTERVAL_MS);
  timer.unref();
}

/**
 * Deletes refresh tokens that are past expiry, plus revoked tokens
 * older than the retention window (default 30 days — revoked rows are
 * kept briefly as the reuse-detection audit trail). Safe to call
 * repeatedly; returns the number of rows deleted.
 */
export async function deleteExpiredRefreshTokens(retentionDays = 30): Promise<{ count: number }> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const result = await getPrismaClient().refreshToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: cutoff } }] },
  });
  return { count: result.count };
}

/** The authenticated account's identity and tenant context (GET /api/dashboard/me). */
export async function getMe(accountId: string): Promise<MeResult> {
  const account = await getPrismaClient().account.findUnique({
    where: { id: accountId },
    include: {
      owner: { include: { store: true } },
      staffMembers: { include: { store: true } },
    },
  });
  if (account === null) {
    throw new AppError(
      401,
      "ACCOUNT_MISSING",
      "Your account no longer exists — please contact support",
    );
  }
  const membership = resolveMembership(account);
  return {
    ...userInfo(account),
    permissions: membership?.permissions ?? [],
  };
}

/**
 * Permanently deletes the account and — when it owns a store — the whole
 * tenant. One transaction: the store (and every tenant-scoped row via
 * cascade) goes first, then the ownership record, then the account. This
 * ordering satisfies the schema's Owner.accountId onDelete: Restrict
 * guard (an account with an ownership record cannot be deleted while its
 * store exists). Staff memberships for the account in other stores die
 * with the account (StaffMember.account onDelete: Cascade).
 */
export async function deleteAccount(accountId: string): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.$transaction(async (tx) => {
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { id: true, owner: { select: { storeId: true } } },
    });
    if (account === null) {
      throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
    }
    if (account.owner !== null) {
      await tx.store.delete({ where: { id: account.owner.storeId } });
    }
    await tx.account.delete({ where: { id: accountId } });
  });
}
