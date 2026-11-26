import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";
import { formatRefreshToken } from "../../lib/tokens.js";
import { AppError } from "../../lib/AppError.js";
import { PERMISSIONS } from "../../lib/permissions.js";
import type { PrismaClient } from "../../../generated/prisma/client.js";

// Prisma is stubbed at the module boundary: every service and middleware
// resolves the client via getPrismaClient(), so unit tests swap in a stub
// without touching the real database.
const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

import {
  changePassword,
  deleteAccount,
  deleteExpiredInviteTokens,
  deleteExpiredOtpChallenges,
  deleteExpiredPasswordResetGrants,
  deleteExpiredRefreshTokens,
  getMe,
  googleSignIn,
  login,
  logout,
  onboardAccount,
  refresh,
  register,
  resendVerification,
  verifyEmail,
} from "./service.js";
import type { VerificationEmailData, VerificationEmailSender } from "./service.js";
import type { GoogleOAuthClient, GoogleProfile } from "./google.js";

/** Records every send attempt; never touches the network. */
function fakeVerificationSender(): VerificationEmailSender & { sent: VerificationEmailData[] } {
  const sent: VerificationEmailData[] = [];
  return {
    sent,
    async sendVerificationEmail(data: VerificationEmailData): Promise<void> {
      sent.push(data);
    },
  };
}

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  $transaction: Mock;
  $queryRaw: Mock;
  account: { create: Mock; findUnique: Mock; update: Mock; delete: Mock };
  store: { create: Mock; update: Mock; delete: Mock };
  branch: { create: Mock };
  owner: { create: Mock; findUnique: Mock };
  storeTemplate: { findMany: Mock };
  refreshToken: { create: Mock; findUnique: Mock; updateMany: Mock; deleteMany: Mock };
  inviteToken: { deleteMany: Mock };
  otpChallenge: {
    create: Mock;
    findFirst: Mock;
    count: Mock;
    updateMany: Mock;
    deleteMany: Mock;
  };
  passwordResetToken: { create: Mock; findUnique: Mock; updateMany: Mock; deleteMany: Mock };
}

function createStub(): PrismaStub {
  const stub: PrismaStub = {
    $transaction: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ id: "account-1" }]),
    account: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    store: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    branch: { create: vi.fn() },
    owner: { create: vi.fn(), findUnique: vi.fn() },
    storeTemplate: { findMany: vi.fn() },
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    inviteToken: { deleteMany: vi.fn() },
    otpChallenge: {
      create: vi.fn().mockResolvedValue({ id: "otp-1" }),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn(),
    },
    passwordResetToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  // Transactions run the callback against the same stub (rollback is
  // simulated by the callback throwing before later calls happen).
  stub.$transaction.mockImplementation(async (fn: (tx: PrismaStub) => Promise<unknown>) =>
    fn(stub),
  );
  return stub;
}

const p2002 = (target: string | string[]) =>
  Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target },
  });

/**
 * Prisma 7 + driver adapters report unique violations through
 * meta.driverAdapterError instead of meta.target (see service.ts
 * isUniqueViolation for the full shape handling).
 */
const p2002Adapter = (fields: string[]) =>
  Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: "23505",
          kind: "UniqueConstraintViolation",
          constraint: { fields },
        },
      },
    },
  });

const VALID_REGISTER = {
  firstName: "Ade",
  lastName: "Okafor",
  phone: "+234 801 234 5678",
  email: "owner@example.com",
  password: "password-123",
  confirmPassword: "password-123",
};

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "account-1",
    email: VALID_REGISTER.email,
    passwordHash: "",
    firstName: VALID_REGISTER.firstName,
    lastName: VALID_REGISTER.lastName,
    phone: VALID_REGISTER.phone,
    // Verified by default: most flows assume a verified account; the
    // verification-gate tests override this to null explicitly.
    emailVerifiedAt: new Date("2026-08-08T00:00:00.000Z"),
    googleSub: null,
    ...overrides,
  };
}

function ownerMembership(overrides: Record<string, unknown> = {}) {
  return {
    id: "owner-1",
    accountId: "account-1",
    storeId: "store-1",
    store: { id: "store-1", name: "Ades Store", subdomain: "ades-store" },
    ...overrides,
  };
}

function staffMembership(overrides: Record<string, unknown> = {}) {
  return [
    {
      id: "staff-1",
      accountId: "account-1",
      storeId: "store-1",
      role: "STAFF",
      permissions: ["orders.manage"],
      store: { id: "store-1", name: "Ades Store", subdomain: "ades-store" },
      ...overrides,
    },
  ];
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  // Onboarding resolves the storefront template (the pre-subscription
  // STARTER set) before the store-create transaction; a two-row catalog
  // keeps the template path exercised without coupling every test to it.
  // Ids are valid UUIDs — the onboarding schema validates the shape.
  stub.storeTemplate.findMany.mockResolvedValue([
    { id: "019FC8C4-5A01-7001-8001-000000000001", slug: "market", sortOrder: 1 },
    { id: "019FC8C4-5A01-7001-8001-000000000002", slug: "boutique", sortOrder: 2 },
  ]);
});

describe("register (unit)", () => {
  it("creates an Account, stores only a hashed verification OTP, mails it, and returns a session", async () => {
    stub.account.create.mockResolvedValue(accountRow());
    stub.refreshToken.create.mockResolvedValue({ id: "token-1", accountId: "account-1" });
    const sender = fakeVerificationSender();

    const result = await register(VALID_REGISTER, sender);

    expect(stub.$transaction).toHaveBeenCalledOnce();
    expect(stub.store.create).not.toHaveBeenCalled();
    expect(stub.owner.create).not.toHaveBeenCalled();
    const created = stub.account.create.mock.calls[0]![0] as {
      data: {
        email: string;
        passwordHash: string;
        firstName: string;
        lastName: string;
        phone: string;
      };
    };
    expect(created.data).toMatchObject({
      email: VALID_REGISTER.email,
      firstName: "Ade",
      lastName: "Okafor",
      phone: "+234 801 234 5678",
    });
    expect(created.data.passwordHash).not.toBe(VALID_REGISTER.password);
    expect(await bcrypt.compare(VALID_REGISTER.password, created.data.passwordHash)).toBe(true);
    const challengeCall = stub.otpChallenge.create.mock.calls[0]![0] as {
      data: { codeHash: string; purpose: string; destination: string; accountId: string; expiresAt: Date };
    };
    expect(challengeCall.data.accountId).toBe("account-1");
    expect(challengeCall.data.destination).toBe(VALID_REGISTER.email);
    expect(challengeCall.data.purpose).toBe("EMAIL_VERIFICATION");
    expect(challengeCall.data.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sender.sent[0]!.code).toMatch(/^\d{6}$/);
    expect(challengeCall.data.codeHash).not.toBe(sender.sent[0]!.code);
    const ttl = challengeCall.data.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({
      to: VALID_REGISTER.email,
      code: sender.sent[0]!.code,
      expiresAt: challengeCall.data.expiresAt,
    });
    expect(result.user).toEqual({
      accountId: "account-1",
      email: "owner@example.com",
      firstName: "Ade",
      lastName: "Okafor",
      phone: "+234 801 234 5678",
      role: null,
      storeId: null,
      storeName: null,
      subdomain: null,
      needsOnboarding: true,
      verified: false,
    });
    expect(result.accessToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(result.refreshToken).toMatch(/^rt_/);
  });

  it("registers successfully even when the verification email cannot be delivered", async () => {
    stub.account.create.mockResolvedValue(accountRow());
    stub.refreshToken.create.mockResolvedValue({ id: "token-1", accountId: "account-1" });
    const sender = fakeVerificationSender();
    sender.sendVerificationEmail = async () => {
      throw new Error("resend 500 server error");
    };

    const result = await register(VALID_REGISTER, sender);

    expect(result.accessToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(stub.otpChallenge.create).toHaveBeenCalledOnce();
  });

  it("rejects a duplicate email with EMAIL_TAKEN (409) and sends nothing", async () => {
    stub.account.create.mockRejectedValue(p2002("email"));
    const sender = fakeVerificationSender();

    await expect(register(VALID_REGISTER, sender)).rejects.toMatchObject({
      code: "EMAIL_TAKEN",
      statusCode: 409,
    });
    expect(stub.otpChallenge.create).not.toHaveBeenCalled();
    expect(sender.sent).toHaveLength(0);
  });

  it("maps a driver-adapter P2002 error to EMAIL_TAKEN", async () => {
    stub.account.create.mockRejectedValue(p2002Adapter(["email"]));
    await expect(register(VALID_REGISTER, fakeVerificationSender())).rejects.toMatchObject({
      code: "EMAIL_TAKEN",
      statusCode: 409,
    });
  });

  it("validates input before touching the database (400 VALIDATION_ERROR)", async () => {
    const sender = fakeVerificationSender();
    await expect(
      register({ ...VALID_REGISTER, email: "not-an-email" }, sender),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
    await expect(register({ ...VALID_REGISTER, password: "short" }, sender)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(register({ ...VALID_REGISTER, firstName: "" }, sender)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      register({ ...VALID_REGISTER, phone: "not-a-phone" }, sender),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      register({ ...VALID_REGISTER, confirmPassword: "different-password" }, sender),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(stub.account.create).not.toHaveBeenCalled();
    expect(stub.otpChallenge.create).not.toHaveBeenCalled();
    expect(sender.sent).toHaveLength(0);
  });
});

describe("verifyEmail (unit)", () => {
  const EMAIL = "owner@example.com";
  const CODE = "042817";
  const FUTURE = new Date(Date.now() + 10 * 60 * 1000);

  function challengeRow(overrides: Record<string, unknown> = {}) {
    const codeHash = createHmac("sha256", env.OTP_HMAC_SECRET)
      .update(`EMAIL_VERIFICATION\0account-1\0${EMAIL}\0${CODE}`)
      .digest("hex");
    return {
      id: "otp-1",
      accountId: "account-1",
      purpose: "EMAIL_VERIFICATION",
      destination: EMAIL,
      codeHash,
      attempts: 0,
      expiresAt: FUTURE,
      usedAt: null,
      invalidatedAt: null,
      createdAt: new Date(),
      ...overrides,
    };
  }

  it("consumes the OTP and marks the account verified in one transaction", async () => {
    stub.account.findUnique.mockResolvedValue({ id: "account-1" });
    stub.otpChallenge.findFirst.mockResolvedValue(challengeRow());
    stub.otpChallenge.updateMany.mockResolvedValue({ count: 1 });
    stub.account.update.mockResolvedValue(accountRow());

    const result = await verifyEmail({ email: EMAIL, code: CODE });

    expect(result).toEqual({ verified: true });
    expect(stub.$transaction).toHaveBeenCalledOnce();
    expect(stub.otpChallenge.findFirst).toHaveBeenCalledWith({
      where: {
        accountId: "account-1",
        purpose: "EMAIL_VERIFICATION",
        destination: EMAIL,
        usedAt: null,
        invalidatedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(stub.otpChallenge.updateMany).toHaveBeenCalledWith({
      where: {
        id: "otp-1",
        attempts: { lt: expect.any(Number) },
        usedAt: null,
        invalidatedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { usedAt: expect.any(Date) },
    });
    expect(stub.account.update).toHaveBeenCalledWith({
      where: { id: "account-1" },
      data: { emailVerifiedAt: expect.any(Date) },
    });
  });

  it("increments incorrect attempts and invalidates at the fifth attempt", async () => {
    stub.account.findUnique.mockResolvedValue({ id: "account-1" });
    stub.otpChallenge.findFirst.mockResolvedValue(challengeRow({ attempts: 4 }));
    stub.otpChallenge.updateMany.mockResolvedValue({ count: 1 });

    await expect(verifyEmail({ email: EMAIL, code: "111111" })).rejects.toMatchObject({
      code: "OTP_INVALID",
    });
    const update = stub.otpChallenge.updateMany.mock.calls.at(-1)![0] as {
      data: { attempts: number; invalidatedAt: Date };
    };
    expect(update.data.attempts).toBe(5);
    expect(update.data.invalidatedAt).toBeInstanceOf(Date);
  });

  it("rejects an expired or missing challenge with the same generic error", async () => {
    stub.account.findUnique.mockResolvedValue({ id: "account-1" });
    stub.otpChallenge.findFirst.mockResolvedValue(
      challengeRow({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(verifyEmail({ email: EMAIL, code: CODE })).rejects.toMatchObject({
      code: "OTP_INVALID",
      statusCode: 400,
    });

    stub.otpChallenge.findFirst.mockResolvedValue(null);
    await expect(verifyEmail({ email: EMAIL, code: CODE })).rejects.toMatchObject({
      code: "OTP_INVALID",
      statusCode: 400,
    });
  });

  it("does not reveal whether an email has an account", async () => {
    stub.account.findUnique.mockResolvedValue(null);
    await expect(verifyEmail({ email: "nobody@example.com", code: CODE })).rejects.toMatchObject({
      code: "OTP_INVALID",
      statusCode: 400,
    });
  });

  it("validates email and six-digit code before database access", async () => {
    await expect(verifyEmail({ email: EMAIL, code: "12" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
    await expect(verifyEmail({ email: "bad-email", code: CODE })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(stub.account.findUnique).not.toHaveBeenCalled();
  });
});

describe("resendVerification (unit)", () => {
  it("issues, stores only a purpose-bound HMAC, and sends a fresh code", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow({ emailVerifiedAt: null }));
    const sender = fakeVerificationSender();

    const result = await resendVerification("account-1", sender);

    expect(result).toEqual({ sent: true });
    const create = stub.otpChallenge.create.mock.calls[0]![0] as {
      data: { purpose: string; destination: string; codeHash: string; accountId: string; expiresAt: Date };
    };
    expect(create.data).toMatchObject({
      accountId: "account-1",
      purpose: "EMAIL_VERIFICATION",
      destination: VALID_REGISTER.email,
    });
    expect(create.data.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.code).toMatch(/^\d{6}$/);
    expect(create.data.codeHash).not.toBe(sender.sent[0]!.code);
    expect(create.data.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("rejects an already-verified account", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow());
    await expect(resendVerification("account-1", fakeVerificationSender())).rejects.toMatchObject({
      code: "ALREADY_VERIFIED",
      statusCode: 409,
    });
    expect(stub.otpChallenge.create).not.toHaveBeenCalled();
  });

  it("enforces the 60-second resend cooldown", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow({ emailVerifiedAt: null }));
    stub.otpChallenge.findFirst.mockResolvedValue({
      id: "recent",
      createdAt: new Date(Date.now() - 10_000),
    });
    await expect(resendVerification("account-1", fakeVerificationSender())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      statusCode: 429,
    });
    expect(stub.otpChallenge.create).not.toHaveBeenCalled();
  });

  it("limits requests in the configured account window", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow({ emailVerifiedAt: null }));
    stub.otpChallenge.findFirst.mockResolvedValue({
      id: "old",
      createdAt: new Date(Date.now() - 2 * 60_000),
    });
    stub.otpChallenge.count.mockResolvedValue(5);
    await expect(resendVerification("account-1", fakeVerificationSender())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      statusCode: 429,
    });
  });

  it("invalidates the code if mail delivery fails", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow({ emailVerifiedAt: null }));
    const sender = fakeVerificationSender();
    sender.sendVerificationEmail = async () => {
      throw new Error("provider failure");
    };
    await expect(resendVerification("account-1", sender)).resolves.toEqual({ sent: true });
    expect(stub.otpChallenge.updateMany).toHaveBeenCalledWith({
      where: { id: "otp-1", usedAt: null, invalidatedAt: null },
      data: { invalidatedAt: expect.any(Date) },
    });
  });
});
describe("onboardAccount (unit)", () => {
  const PROFILE = {
    name: "Ades Store",
    businessType: "RETAIL",
    location: "Lagos, Nigeria",
    currency: "NGN",
    businessPhone: "+234 801 234 5678",
  };

  function happyPathMocks(subdomain: string) {
    stub.account.findUnique.mockResolvedValue(accountRow({ owner: null, staffMembers: [] }));
    stub.store.create.mockResolvedValue({
      id: "store-1",
      name: "Ades Store",
      subdomain,
    });
    stub.branch.create.mockResolvedValue({ id: "branch-1", storeId: "store-1" });
    stub.store.update.mockResolvedValue({});
    stub.owner.create.mockResolvedValue({ id: "owner-1" });
    stub.owner.findUnique.mockResolvedValue(null);
  }

  it("creates Store + Owner with an auto-generated subdomain and returns the tenant context", async () => {
    happyPathMocks("ades-store");

    const result = await onboardAccount("account-1", PROFILE);

    expect(stub.$transaction).toHaveBeenCalledOnce();
    expect(stub.store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Ades Store",
          subdomain: "ades-store",
          businessType: "RETAIL",
          location: "Lagos, Nigeria",
          currency: "NGN",
          businessPhone: "+234 801 234 5678",
        }),
      }),
    );
    expect(stub.owner.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { accountId: "account-1", storeId: "store-1" } }),
    );
    expect(result).toEqual({
      accountId: "account-1",
      email: "owner@example.com",
      firstName: "Ade",
      lastName: "Okafor",
      phone: "+234 801 234 5678",
      role: "OWNER",
      storeId: "store-1",
      storeName: "Ades Store",
      subdomain: "ades-store",
      needsOnboarding: false,
      verified: true,
    });
  });

  it("sends the best-effort welcome email to the new owner after the store is created", async () => {
    happyPathMocks("ades-store");
    const sendWelcomeEmail = vi.fn().mockResolvedValue(undefined);

    const result = await onboardAccount("account-1", PROFILE, { sendWelcomeEmail });

    expect(sendWelcomeEmail).toHaveBeenCalledWith({
      to: "owner@example.com",
      storeName: "Ades Store",
    });
    expect(result.storeName).toBe("Ades Store");
  });

  it("swallows a welcome-email failure — onboarding must never fail because mail did", async () => {
    happyPathMocks("ades-store");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sendWelcomeEmail = vi.fn().mockRejectedValue(new Error("resend 500"));

    const result = await onboardAccount("account-1", PROFILE, { sendWelcomeEmail });

    expect(result.storeId).toBe("store-1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[welcome-email]"));
  });

  it("defaults the store's template to the first visible template when templateId is omitted", async () => {
    happyPathMocks("ades-store");

    await onboardAccount("account-1", PROFILE);

    expect(stub.store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ templateId: "019FC8C4-5A01-7001-8001-000000000001" }),
      }),
    );
  });

  it("attaches the chosen template when templateId is provided", async () => {
    happyPathMocks("ades-store");

    await onboardAccount("account-1", {
      ...PROFILE,
      templateId: "019FC8C4-5A01-7001-8001-000000000002",
    });

    expect(stub.store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ templateId: "019FC8C4-5A01-7001-8001-000000000002" }),
      }),
    );
  });

  it("rejects a template outside the STARTER set (400 TEMPLATE_NOT_AVAILABLE) before any write", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow({ owner: null, staffMembers: [] }));

    await expect(
      onboardAccount("account-1", {
        ...PROFILE,
        templateId: "019FC8C4-5A01-7001-8001-000000000099",
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_AVAILABLE", statusCode: 400 });
    expect(stub.$transaction).not.toHaveBeenCalled();
    expect(stub.store.create).not.toHaveBeenCalled();
  });

  it("rejects an unverified account with VERIFICATION_REQUIRED (403) before any writes", async () => {
    stub.account.findUnique.mockResolvedValue(
      accountRow({ emailVerifiedAt: null, owner: null, staffMembers: [] }),
    );

    await expect(onboardAccount("account-1", PROFILE)).rejects.toMatchObject({
      code: "VERIFICATION_REQUIRED",
      statusCode: 403,
    });
    expect(stub.$transaction).not.toHaveBeenCalled();
    expect(stub.store.create).not.toHaveBeenCalled();
  });

  it("advances to the next candidate when the base slug is already taken", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow({ owner: null, staffMembers: [] }));
    stub.store.create
      .mockRejectedValueOnce(p2002(["subdomain"]))
      .mockResolvedValueOnce({ id: "store-1", name: "Ades Store", subdomain: "ades-store-2" });
    stub.branch.create.mockResolvedValue({ id: "branch-1", storeId: "store-1" });
    stub.store.update.mockResolvedValue({});
    stub.owner.create.mockResolvedValue({ id: "owner-1" });
    stub.owner.findUnique.mockResolvedValue(null);

    const result = await onboardAccount("account-1", PROFILE);

    expect(stub.store.create).toHaveBeenCalledTimes(2);
    const secondCreate = stub.store.create.mock.calls[1]![0] as {
      data: { subdomain: string };
    };
    expect(secondCreate.data.subdomain).toBe("ades-store-2");
    expect(result.subdomain).toBe("ades-store-2");
    expect(stub.owner.create).toHaveBeenCalledOnce();
  });

  it("rejects a name whose derived subdomain is reserved (409 SUBDOMAIN_RESERVED)", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow({ owner: null, staffMembers: [] }));

    await expect(onboardAccount("account-1", { ...PROFILE, name: "Brikoh" })).rejects.toMatchObject(
      {
        code: "SUBDOMAIN_RESERVED",
        statusCode: 409,
        message: "That store name isn't available — please choose a different one.",
      },
    );
    expect(stub.$transaction).not.toHaveBeenCalled();
    expect(stub.store.create).not.toHaveBeenCalled();
  });

  it("rejects a name too short to derive a 4-char subdomain (409 SUBDOMAIN_TOO_SHORT)", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow({ owner: null, staffMembers: [] }));

    await expect(onboardAccount("account-1", { ...PROFILE, name: "Abc" })).rejects.toMatchObject({
      code: "SUBDOMAIN_TOO_SHORT",
      statusCode: 409,
      message: "Please choose a store name with at least 4 letters or numbers.",
    });
    expect(stub.$transaction).not.toHaveBeenCalled();
    expect(stub.store.create).not.toHaveBeenCalled();
  });

  it("falls back to a random store- subdomain when every candidate is taken", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow({ owner: null, staffMembers: [] }));
    let createCalls = 0;
    stub.store.create.mockImplementation(async () => {
      createCalls += 1;
      // Base slug + 98 numeric suffixes are all taken; the first random
      // fallback (call 100) succeeds.
      if (createCalls < 100) throw p2002(["subdomain"]);
      return { id: "store-1", name: "Ades Store", subdomain: "store-abc12345" };
    });
    stub.branch.create.mockResolvedValue({ id: "branch-1", storeId: "store-1" });
    stub.store.update.mockResolvedValue({});
    stub.owner.create.mockResolvedValue({ id: "owner-1" });
    stub.owner.findUnique.mockResolvedValue(null);

    const result = await onboardAccount("account-1", PROFILE);

    expect(stub.store.create).toHaveBeenCalledTimes(100);
    const lastCreate = stub.store.create.mock.calls[99]![0] as { data: { subdomain: string } };
    expect(lastCreate.data.subdomain).toMatch(/^store-[a-z]{8}$/);
    expect(result.subdomain).toBe("store-abc12345");
  });

  it("rejects an account that already owns a store with ALREADY_ONBOARDED (409)", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow({ owner: null, staffMembers: [] }));
    stub.owner.findUnique.mockResolvedValue({ id: "owner-1", accountId: "account-1" });

    await expect(onboardAccount("account-1", PROFILE)).rejects.toMatchObject({
      code: "ALREADY_ONBOARDED",
      statusCode: 409,
    });
    expect(stub.store.create).not.toHaveBeenCalled();
  });

  it("maps the accountId unique-violation race to ALREADY_ONBOARDED (409)", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow({ owner: null, staffMembers: [] }));
    stub.owner.findUnique.mockResolvedValue(null);
    stub.store.create.mockResolvedValue({ id: "store-1" });
    stub.branch.create.mockResolvedValue({ id: "branch-1", storeId: "store-1" });
    stub.store.update.mockResolvedValue({});
    stub.owner.create.mockRejectedValue(p2002Adapter(["accountId"]));

    await expect(onboardAccount("account-1", PROFILE)).rejects.toMatchObject({
      code: "ALREADY_ONBOARDED",
      statusCode: 409,
    });
  });

  it("surfaces SUBDOMAIN_TAKEN when every candidate is taken and leaves no Owner", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow({ owner: null, staffMembers: [] }));
    stub.owner.findUnique.mockResolvedValue(null);
    stub.store.create.mockRejectedValue(p2002(["subdomain"]));

    await expect(onboardAccount("account-1", PROFILE)).rejects.toMatchObject({
      code: "SUBDOMAIN_TAKEN",
      statusCode: 409,
    });
    expect(stub.owner.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown account with ACCOUNT_MISSING (401)", async () => {
    stub.account.findUnique.mockResolvedValue(null);

    await expect(onboardAccount("account-1", PROFILE)).rejects.toMatchObject({
      code: "ACCOUNT_MISSING",
      statusCode: 401,
    });
  });

  it("validates input before touching the database (400 VALIDATION_ERROR)", async () => {
    await expect(onboardAccount("account-1", { ...PROFILE, name: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      onboardAccount("account-1", { ...PROFILE, businessType: "NOT_A_TYPE" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      onboardAccount("account-1", { ...PROFILE, currency: "XOF" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(onboardAccount("account-1", { ...PROFILE, location: "X" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      onboardAccount("account-1", { ...PROFILE, businessPhone: "not-a-phone" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // Store names are letters and spaces only — digits, punctuation, and
    // symbols are rejected up front with a plain-language message.
    await expect(
      onboardAccount("account-1", { ...PROFILE, name: "7-Eleven" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      onboardAccount("account-1", { ...PROFILE, name: "Ade's Store" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // The shape is strict: a stale client still sending the removed
    // website question is rejected instead of silently stripped.
    await expect(
      onboardAccount("account-1", { ...PROFILE, wantWebsite: true, subdomain: "ades-store" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(stub.account.findUnique).not.toHaveBeenCalled();
  });
});

describe("login (unit)", () => {
  const passwordHash = bcrypt.hashSync(VALID_REGISTER.password, 4);

  it("logs in an owner with role OWNER and a store context", async () => {
    stub.account.findUnique.mockResolvedValue(
      accountRow({ passwordHash, owner: ownerMembership(), staffMembers: [] }),
    );
    stub.refreshToken.create.mockResolvedValue({ id: "token-1", accountId: "account-1" });

    const result = await login({ email: VALID_REGISTER.email, password: VALID_REGISTER.password });

    expect(result.user.role).toBe("OWNER");
    expect(result.user.storeId).toBe("store-1");
    expect(result.user.storeName).toBe("Ades Store");
    expect(result.user.verified).toBe(true);
  });

  it("logs in a staff member with their role and store context", async () => {
    stub.account.findUnique.mockResolvedValue(
      accountRow({ passwordHash, owner: null, staffMembers: staffMembership() }),
    );
    stub.refreshToken.create.mockResolvedValue({ id: "token-1", accountId: "account-1" });

    const result = await login({ email: VALID_REGISTER.email, password: VALID_REGISTER.password });

    expect(result.user.role).toBe("STAFF");
    expect(result.user.accountId).toBe("account-1");
  });

  it("resolves to OWNER when the account is both owner and staff", async () => {
    stub.account.findUnique.mockResolvedValue(
      accountRow({ passwordHash, owner: ownerMembership(), staffMembers: staffMembership() }),
    );
    stub.refreshToken.create.mockResolvedValue({ id: "token-1", accountId: "account-1" });

    const result = await login({ email: VALID_REGISTER.email, password: VALID_REGISTER.password });

    expect(result.user.role).toBe("OWNER");
  });

  it("rejects a wrong password with INVALID_CREDENTIALS (401)", async () => {
    stub.account.findUnique.mockResolvedValue(
      accountRow({ passwordHash, owner: ownerMembership(), staffMembers: [] }),
    );

    await expect(
      login({ email: VALID_REGISTER.email, password: "wrong-password" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", statusCode: 401 });
  });

  it("rejects an unknown email with the same INVALID_CREDENTIALS code", async () => {
    stub.account.findUnique.mockResolvedValue(null);

    await expect(
      login({ email: "nobody@example.com", password: VALID_REGISTER.password }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("logs in an account without a membership with needsOnboarding: true", async () => {
    stub.account.findUnique.mockResolvedValue(
      accountRow({ passwordHash, emailVerifiedAt: null, owner: null, staffMembers: [] }),
    );
    stub.refreshToken.create.mockResolvedValue({ id: "token-1", accountId: "account-1" });

    const result = await login({
      email: VALID_REGISTER.email,
      password: VALID_REGISTER.password,
    });

    expect(result.user.role).toBeNull();
    expect(result.user.storeId).toBeNull();
    expect(result.user.storeName).toBeNull();
    expect(result.user.subdomain).toBeNull();
    expect(result.user.needsOnboarding).toBe(true);
    expect(result.user.verified).toBe(false);
  });
});

describe("googleSignIn (unit)", () => {
  const REDIRECT = "https://brikoh.com/auth/google/callback";

  function googleClient(profileByCode: Record<string, GoogleProfile>): GoogleOAuthClient {
    return {
      async exchangeCode(code: string): Promise<GoogleProfile> {
        const profile = profileByCode[code];
        if (profile === undefined) {
          throw new AppError(401, "GOOGLE_AUTH_FAILED", "Google rejected the authorization code");
        }
        return profile;
      },
    };
  }

  const profile = (overrides: Partial<GoogleProfile> = {}): GoogleProfile => ({
    sub: "google-sub-1",
    email: "google.user@example.com",
    firstName: "Google",
    lastName: "User",
    ...overrides,
  });

  it("creates a Google-native account when no account matches", async () => {
    const client = googleClient({ "code-1": profile() });
    stub.account.findUnique.mockResolvedValue(null);
    stub.account.create.mockResolvedValue(
      accountRow({
        email: "google.user@example.com",
        googleSub: "google-sub-1",
        emailVerifiedAt: new Date(),
        owner: null,
        staffMembers: [],
      }),
    );
    stub.refreshToken.create.mockResolvedValue({ id: "token-1", accountId: "account-1" });

    const result = await googleSignIn(client, { code: "code-1", redirectUri: REDIRECT });

    expect(stub.account.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "google.user@example.com",
          googleSub: "google-sub-1",
          firstName: "Google",
          lastName: "User",
          emailVerifiedAt: expect.any(Date),
        }),
      }),
    );
    expect(result.user.role).toBeNull();
    expect(result.user.storeId).toBeNull();
    expect(result.user.verified).toBe(true);
    expect(result.user.needsOnboarding).toBe(true);
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
  });

  it("links googleSub to an existing account found by email", async () => {
    const client = googleClient({ "code-1": profile() });
    stub.account.findUnique.mockResolvedValue(
      accountRow({
        email: "google.user@example.com",
        googleSub: null,
        passwordHash: bcrypt.hashSync("password-123", 4),
        owner: ownerMembership(),
        staffMembers: [],
      }),
    );
    stub.account.update.mockResolvedValue(
      accountRow({
        email: "google.user@example.com",
        googleSub: "google-sub-1",
        passwordHash: bcrypt.hashSync("password-123", 4),
        owner: ownerMembership(),
        staffMembers: [],
      }),
    );
    stub.refreshToken.create.mockResolvedValue({ id: "token-1", accountId: "account-1" });

    const result = await googleSignIn(client, { code: "code-1", redirectUri: REDIRECT });

    expect(stub.account.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "account-1" }, data: { googleSub: "google-sub-1" } }),
    );
    expect(result.user.role).toBe("OWNER");
  });

  it("signs in an account already linked by googleSub without creating or updating", async () => {
    const client = googleClient({ "code-1": profile() });
    stub.account.findUnique.mockResolvedValue(
      accountRow({
        email: "google.user@example.com",
        googleSub: "google-sub-1",
        owner: ownerMembership(),
        staffMembers: [],
      }),
    );
    stub.refreshToken.create.mockResolvedValue({ id: "token-1", accountId: "account-1" });

    const result = await googleSignIn(client, { code: "code-1", redirectUri: REDIRECT });

    expect(stub.account.create).not.toHaveBeenCalled();
    expect(stub.account.update).not.toHaveBeenCalled();
    expect(result.user.role).toBe("OWNER");
  });

  it("rejects an unlisted redirectUri with VALIDATION_ERROR (400)", async () => {
    const client = googleClient({ "code-1": profile() });

    await expect(
      googleSignIn(client, { code: "code-1", redirectUri: "https://evil.example/callback" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    expect(stub.account.findUnique).not.toHaveBeenCalled();
  });

  it("accepts any localhost redirectUri (dev convenience)", async () => {
    const client = googleClient({ "code-1": profile() });
    stub.account.findUnique.mockResolvedValue(null);
    stub.account.create.mockResolvedValue(
      accountRow({
        email: "google.user@example.com",
        googleSub: "google-sub-1",
        emailVerifiedAt: new Date(),
        owner: null,
        staffMembers: [],
      }),
    );
    stub.refreshToken.create.mockResolvedValue({ id: "token-1", accountId: "account-1" });

    const result = await googleSignIn(client, {
      code: "code-1",
      redirectUri: "http://localhost:5173/auth/google/callback",
    });

    expect(result.user.email).toBe("google.user@example.com");
    expect(stub.account.findUnique).toHaveBeenCalled();
  });

  it("surfaces a rejected code as GOOGLE_AUTH_FAILED (401)", async () => {
    const client = googleClient({});

    await expect(
      googleSignIn(client, { code: "bad-code", redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code: "GOOGLE_AUTH_FAILED", statusCode: 401 });
  });

  it("rejects a deactivated staff membership with ACCOUNT_DISABLED (403)", async () => {
    const client = googleClient({ "code-1": profile() });
    stub.account.findUnique.mockResolvedValue(
      accountRow({
        email: "google.user@example.com",
        googleSub: "google-sub-1",
        owner: null,
        staffMembers: staffMembership({ isActive: false }),
      }),
    );

    await expect(
      googleSignIn(client, { code: "code-1", redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code: "ACCOUNT_DISABLED", statusCode: 403 });
  });

  it("resolves a concurrent create race by linking to the winner", async () => {
    const client = googleClient({ "code-1": profile() });
    stub.account.findUnique.mockResolvedValueOnce(null);
    stub.account.findUnique.mockResolvedValueOnce(null);
    stub.account.findUnique.mockResolvedValueOnce(null);
    stub.account.create.mockRejectedValueOnce(p2002Adapter(["googleSub"]));
    stub.account.findUnique.mockResolvedValue(
      accountRow({
        email: "google.user@example.com",
        googleSub: "google-sub-1",
        owner: ownerMembership(),
        staffMembers: [],
      }),
    );
    stub.refreshToken.create.mockResolvedValue({ id: "token-1", accountId: "account-1" });

    const result = await googleSignIn(client, { code: "code-1", redirectUri: REDIRECT });

    expect(result.user.role).toBe("OWNER");
  });

  it("rejects password login for a Google-native account (no passwordHash)", async () => {
    stub.account.findUnique.mockResolvedValue(
      accountRow({
        email: "google.user@example.com",
        googleSub: "google-sub-1",
        passwordHash: null,
      }),
    );

    await expect(
      login({ email: "google.user@example.com", password: "password-123" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });
});

describe("refresh (unit)", () => {
  const secret = "s3cret-value";
  const tokenHash = bcrypt.hashSync(secret, 4);
  const future = new Date(Date.now() + 86_400_000);

  function refreshRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "token-1",
      accountId: "account-1",
      tokenHash,
      expiresAt: future,
      revokedAt: null,
      ...overrides,
    };
  }

  function setupMembership() {
    stub.account.findUnique.mockResolvedValue(
      accountRow({
        passwordHash: "",
        owner: ownerMembership(),
        staffMembers: [],
      }),
    );
  }

  it("rotates the presented token and returns a new pair", async () => {
    setupMembership();
    stub.refreshToken.findUnique.mockResolvedValue(refreshRow());
    stub.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    stub.refreshToken.create.mockResolvedValue({ id: "token-2", accountId: "account-1" });

    const result = await refresh(formatRefreshToken("token-1", secret));

    expect(stub.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "token-1", revokedAt: null },
      }),
    );
    expect(result.accessToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(result.refreshToken).toMatch(/^rt_/);
    const created = stub.refreshToken.create.mock.calls[0]![0] as {
      data: { accountId: string; tokenHash: string; expiresAt: Date };
    };
    expect(created.data.accountId).toBe("account-1");
    expect(created.data.tokenHash).not.toBe(secret);
  });

  it("detects reuse of an already-revoked token: revokes all active sessions and rejects", async () => {
    stub.refreshToken.findUnique.mockResolvedValue(refreshRow({ revokedAt: new Date() }));
    stub.refreshToken.updateMany.mockResolvedValue({ count: 1 });

    await expect(refresh(formatRefreshToken("token-1", secret))).rejects.toMatchObject({
      code: "TOKEN_REUSE_DETECTED",
      statusCode: 401,
    });
    expect(stub.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: "account-1", revokedAt: null },
      }),
    );
  });

  it("rejects an expired token as SESSION_EXPIRED without revoking anything", async () => {
    stub.refreshToken.findUnique.mockResolvedValue(
      refreshRow({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await expect(refresh(formatRefreshToken("token-1", secret))).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
      statusCode: 401,
    });
    expect(stub.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown token id", async () => {
    stub.refreshToken.findUnique.mockResolvedValue(null);

    await expect(refresh(formatRefreshToken("token-1", secret))).rejects.toMatchObject({
      code: "INVALID_REFRESH_TOKEN",
    });
  });

  it("treats a wrong secret on a real row as possible theft", async () => {
    stub.refreshToken.findUnique.mockResolvedValue(refreshRow());
    stub.refreshToken.updateMany.mockResolvedValue({ count: 1 });

    await expect(refresh(formatRefreshToken("token-1", "wrong-secret"))).rejects.toMatchObject({
      code: "TOKEN_REUSE_DETECTED",
    });
  });

  it("handles concurrent rotation: the loser of the updateMany race is rejected and all sessions are revoked", async () => {
    setupMembership();
    stub.refreshToken.findUnique.mockResolvedValue(refreshRow());
    stub.refreshToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(refresh(formatRefreshToken("token-1", secret))).rejects.toMatchObject({
      code: "TOKEN_REUSE_DETECTED",
    });
    expect(stub.refreshToken.create).not.toHaveBeenCalled();
    // The race loser is a reuse signal: every other session is revoked.
    expect(stub.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { accountId: "account-1", revokedAt: null } }),
    );
  });

  it("rotates a token for a tenant-less (un-onboarded) account", async () => {
    stub.refreshToken.findUnique.mockResolvedValue(refreshRow());
    stub.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    stub.refreshToken.create.mockResolvedValue({ id: "token-2", accountId: "account-1" });
    stub.account.findUnique.mockResolvedValue(
      accountRow({ passwordHash: "", owner: null, staffMembers: [] }),
    );

    const result = await refresh(formatRefreshToken("token-1", secret));

    expect(result.accessToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(result.refreshToken).toMatch(/^rt_/);
  });

  it("rejects a token for a deleted account (ACCOUNT_MISSING)", async () => {
    stub.refreshToken.findUnique.mockResolvedValue(refreshRow());
    stub.account.findUnique.mockResolvedValue(null);

    await expect(refresh(formatRefreshToken("token-1", secret))).rejects.toMatchObject({
      code: "ACCOUNT_MISSING",
    });
  });

  it("rejects a malformed raw token", async () => {
    await expect(refresh("not-a-refresh-token")).rejects.toMatchObject({
      code: "INVALID_REFRESH_TOKEN",
    });
    expect(stub.refreshToken.findUnique).not.toHaveBeenCalled();
  });
});

describe("logout (unit)", () => {
  it("revokes the presented token and resolves", async () => {
    stub.refreshToken.findUnique.mockResolvedValue({
      id: "token-1",
      accountId: "account-1",
      revokedAt: null,
    });
    stub.refreshToken.updateMany.mockResolvedValue({ count: 1 });

    await expect(logout(formatRefreshToken("token-1", "secret"))).resolves.toBeUndefined();
    expect(stub.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "token-1", revokedAt: null } }),
    );
  });

  it("is idempotent for an already-revoked token", async () => {
    stub.refreshToken.findUnique.mockResolvedValue({
      id: "token-1",
      accountId: "account-1",
      revokedAt: new Date(),
    });

    await expect(logout(formatRefreshToken("token-1", "secret"))).resolves.toBeUndefined();
    expect(stub.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it("is idempotent for an unknown token", async () => {
    stub.refreshToken.findUnique.mockResolvedValue(null);

    await expect(logout(formatRefreshToken("token-1", "secret"))).resolves.toBeUndefined();
  });

  it("rejects a malformed raw token with VALIDATION_ERROR (400)", async () => {
    await expect(logout("garbage")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
  });
});

describe("changePassword (unit)", () => {
  it("rejects a wrong current password with INVALID_CREDENTIALS", async () => {
    stub.account.findUnique.mockResolvedValue(
      accountRow({ passwordHash: bcrypt.hashSync("current-password", 4) }),
    );

    await expect(
      changePassword("account-1", {
        currentPassword: "wrong-current",
        newPassword: "new-password-1",
        confirmPassword: "new-password-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", statusCode: 401 });
  });

  it("updates the hash and revokes every active refresh token for the account", async () => {
    stub.account.findUnique.mockResolvedValue(
      accountRow({ passwordHash: bcrypt.hashSync("current-password", 4) }),
    );
    stub.account.update.mockResolvedValue(accountRow());
    stub.refreshToken.updateMany.mockResolvedValue({ count: 3 });

    await changePassword("account-1", {
      currentPassword: "current-password",
      newPassword: "new-password-1",
      confirmPassword: "new-password-1",
    });

    const updateCall = stub.account.update.mock.calls[0]![0] as {
      data: { passwordHash: string };
    };
    expect(updateCall.data.passwordHash).not.toBe("new-password-1");
    expect(await bcrypt.compare("new-password-1", updateCall.data.passwordHash)).toBe(true);
    expect(stub.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { accountId: "account-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("rejects a weak new password", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow());

    await expect(
      changePassword("account-1", {
        currentPassword: "current-password",
        newPassword: "weak",
        confirmPassword: "weak",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(stub.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a confirmPassword mismatch", async () => {
    await expect(
      changePassword("account-1", {
        currentPassword: "current-password",
        newPassword: "new-password-1",
        confirmPassword: "different-password",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(stub.account.findUnique).not.toHaveBeenCalled();
  });
});

describe("deleteAccount (unit)", () => {
  it("deletes the owned store first, then the account, in one transaction", async () => {
    stub.account.findUnique.mockResolvedValue({
      id: "account-1",
      owner: { storeId: "store-1" },
    });
    stub.store.delete.mockResolvedValue({ id: "store-1" });
    stub.account.delete.mockResolvedValue({ id: "account-1" });

    await deleteAccount("account-1");

    expect(stub.$transaction).toHaveBeenCalled();
    expect(stub.store.delete).toHaveBeenCalledWith({ where: { id: "store-1" } });
    expect(stub.account.delete).toHaveBeenCalledWith({ where: { id: "account-1" } });
  });

  it("deletes a tenant-less account without touching the store", async () => {
    stub.account.findUnique.mockResolvedValue({ id: "account-1", owner: null });
    stub.account.delete.mockResolvedValue({ id: "account-1" });

    await deleteAccount("account-1");

    expect(stub.store.delete).not.toHaveBeenCalled();
    expect(stub.account.delete).toHaveBeenCalledWith({ where: { id: "account-1" } });
  });

  it("rejects with ACCOUNT_NOT_FOUND when the account no longer exists", async () => {
    stub.account.findUnique.mockResolvedValue(null);

    await expect(deleteAccount("account-1")).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
      statusCode: 404,
    });
    expect(stub.account.delete).not.toHaveBeenCalled();
  });
});

describe("token cleanup (unit)", () => {
  it("deletes only PENDING invites that have expired", async () => {
    stub.inviteToken.deleteMany.mockResolvedValue({ count: 2 });

    const result = await deleteExpiredInviteTokens();

    expect(result).toEqual({ count: 2 });
    const where = stub.inviteToken.deleteMany.mock.calls[0]![0] as {
      where: { status: string; expiresAt: { lt: Date } };
    };
    expect(where.where.status).toBe("PENDING");
    expect(where.where.expiresAt.lt).toBeInstanceOf(Date);
    expect(where.where.expiresAt.lt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("deletes expired refresh tokens and revoked tokens older than the retention window", async () => {
    stub.refreshToken.deleteMany.mockResolvedValue({ count: 4 });

    const result = await deleteExpiredRefreshTokens();

    expect(result).toEqual({ count: 4 });
    const where = stub.refreshToken.deleteMany.mock.calls[0]![0] as unknown as {
      where: { OR: [{ expiresAt: { lt: Date } }, { revokedAt: { lt: Date } }] };
    };
    expect(where.where.OR).toHaveLength(2);
    const expired = where.where.OR[0]!;
    const revoked = where.where.OR[1]!;
    expect(expired.expiresAt.lt).toBeInstanceOf(Date);
    expect(revoked.revokedAt.lt).toBeInstanceOf(Date);
    // 30-day retention: cutoff is 30 days before now.
    const cutoff = revoked.revokedAt.lt;
    expect(cutoff.getTime()).toBeCloseTo(Date.now() - 30 * 86_400_000, -5);
  });

  it("accepts a custom retention window", async () => {
    stub.refreshToken.deleteMany.mockResolvedValue({ count: 1 });

    await deleteExpiredRefreshTokens(7);

    const where = stub.refreshToken.deleteMany.mock.calls[0]![0] as {
      where: { OR: Array<{ revokedAt: { lt: Date } }> };
    };
    const cutoff = where.where.OR[1]!.revokedAt.lt;
    expect(cutoff.getTime()).toBeCloseTo(Date.now() - 7 * 86_400_000, -5);
  });

  it("cleans spent OTP rows after the audit retention window", async () => {
    stub.otpChallenge.deleteMany.mockResolvedValue({ count: 2 });

    const result = await deleteExpiredOtpChallenges();

    expect(result).toEqual({ count: 2 });
    const where = stub.otpChallenge.deleteMany.mock.calls[0]![0] as unknown as {
      where: { createdAt: { lt: Date }; OR: Array<Record<string, unknown>> };
    };
    expect(where.where.createdAt.lt.getTime()).toBeCloseTo(Date.now() - 90 * 86_400_000, -5);
    expect(where.where.OR).toHaveLength(3);
    expect(where.where.OR[0]).toEqual({ expiresAt: { lt: expect.any(Date) } });
    expect(where.where.OR[1]).toEqual({ usedAt: { not: null } });
    expect(where.where.OR[2]).toEqual({ invalidatedAt: { not: null } });
  });

  it("cleans expired and retained used reset grants", async () => {
    stub.passwordResetToken.deleteMany.mockResolvedValue({ count: 3 });
    await expect(deleteExpiredPasswordResetGrants()).resolves.toEqual({ count: 3 });
    const where = stub.passwordResetToken.deleteMany.mock.calls[0]![0] as unknown as {
      where: { OR: Array<Record<string, unknown>> };
    };
    expect(where.where.OR).toHaveLength(2);
    expect(where.where.OR[0]).toEqual({ expiresAt: { lt: expect.any(Date) } });
    expect(where.where.OR[1]).toEqual({ usedAt: { lt: expect.any(Date) } });
  });

  it("is safe to call repeatedly with nothing to delete", async () => {
    stub.inviteToken.deleteMany.mockResolvedValue({ count: 0 });
    stub.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
    stub.otpChallenge.deleteMany.mockResolvedValue({ count: 0 });
    stub.passwordResetToken.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteExpiredInviteTokens()).resolves.toEqual({ count: 0 });
    await expect(deleteExpiredRefreshTokens()).resolves.toEqual({ count: 0 });
    await expect(deleteExpiredOtpChallenges()).resolves.toEqual({ count: 0 });
    await expect(deleteExpiredPasswordResetGrants()).resolves.toEqual({ count: 0 });
  });
});

describe("getMe (unit)", () => {
  it("returns the owner context with the full permission set", async () => {
    stub.account.findUnique.mockResolvedValue(
      accountRow({ owner: ownerMembership(), staffMembers: [] }),
    );

    const result = await getMe("account-1");

    expect(result).toMatchObject({
      accountId: "account-1",
      email: "owner@example.com",
      storeId: "store-1",
      storeName: "Ades Store",
      subdomain: "ades-store",
      role: "OWNER",
    });
    expect(result.permissions).toEqual([...PERMISSIONS]);
  });

  it("returns the staff context with the staff member's permissions", async () => {
    stub.account.findUnique.mockResolvedValue(
      accountRow({ owner: null, staffMembers: staffMembership() }),
    );

    const result = await getMe("account-1");

    expect(result.role).toBe("STAFF");
    expect(result.permissions).toEqual(["orders.manage"]);
  });

  it("returns needsOnboarding: true with empty permissions for a tenant-less account", async () => {
    stub.account.findUnique.mockResolvedValue(accountRow({ owner: null, staffMembers: [] }));

    const result = await getMe("account-1");

    expect(result.role).toBeNull();
    expect(result.storeId).toBeNull();
    expect(result.needsOnboarding).toBe(true);
    expect(result.permissions).toEqual([]);
  });
});
