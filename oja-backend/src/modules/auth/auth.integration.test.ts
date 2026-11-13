import { beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { errorHandler } from "../../middleware/errorHandler.js";
import { authenticate } from "../../middleware/authenticate.js";
import { resolveTenant } from "../../middleware/resolveTenant.js";
import { authorize } from "../../middleware/authorize.js";
import { env } from "../../config/env.js";
import { formatRefreshToken, signAccessToken } from "../../lib/tokens.js";
import { PERMISSIONS } from "../../lib/permissions.js";
import {
  changePassword,
  deleteExpiredInviteTokens,
  deleteExpiredRefreshTokens,
  deleteExpiredVerificationTokens,
} from "./service.js";
import type { $Enums } from "../../../generated/prisma/client.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

const VALID = {
  firstName: "Ade",
  lastName: "Okafor",
  phone: "+234 801 234 5678",
  email: "owner@example.com",
  password: "password-123",
  confirmPassword: "password-123",
};

const ONBOARD_PROFILE = {
  name: "Ades Store",
  businessType: "RETAIL",
  location: "Lagos, Nigeria",
  currency: "NGN",
  businessPhone: "+234 801 234 5678",
};

async function registerViaApi(overrides: Partial<typeof VALID> = {}) {
  return request(app)
    .post("/api/public/auth/register")
    .send({ ...VALID, ...overrides });
}

/**
 * Presents the latest verification token for the account at
 * POST /api/public/auth/verify — the integration suite reads the token
 * from the database because it travels through the (stubbed) email.
 */
async function verifyLatestToken(email: string) {
  const account = await prisma.account.findUnique({ where: { email } });
  expect(account).not.toBeNull();
  const row = await prisma.accountVerificationToken.findFirst({
    where: { accountId: account!.id },
    orderBy: { createdAt: "desc" },
  });
  expect(row).not.toBeNull();
  const res = await request(app).post("/api/public/auth/verify").send({ token: row!.token });
  expect(res.status).toBe(200);
  return { res, token: row!.token };
}

/** Registers and completes the email-verification step. */
async function registerAndVerify() {
  const reg = await registerViaApi();
  await verifyLatestToken(reg.body.user.email);
  return reg;
}

async function onboardViaApi(accessToken: string, body: Record<string, unknown>) {
  return request(app)
    .post("/api/dashboard/onboarding")
    .set("Authorization", `Bearer ${accessToken}`)
    .send(body);
}

async function registerAndOnboard() {
  const reg = await registerAndVerify();
  const onboard = await onboardViaApi(reg.body.accessToken, ONBOARD_PROFILE);
  return { reg, onboard };
}

async function loginViaApi(email: string, password: string) {
  return request(app).post("/api/public/auth/login").send({ email, password });
}

async function createAccount(password = "password-123") {
  const email = `account-${crypto.randomUUID()}@example.com`;
  const account = await prisma.account.create({
    data: { email, passwordHash: bcrypt.hashSync(password, 4) },
  });
  return { account, email };
}

async function createTenantWithOwner() {
  const { account, email } = await createAccount();
  const store = await prisma.store.create({
    data: {
      name: `Store ${crypto.randomUUID().slice(0, 8)}`,
      subdomain: `s-${crypto.randomUUID().slice(0, 8)}`,
      businessType: "OTHER",
      location: "Lagos, Nigeria",
      businessPhone: "+234 801 234 5678",
    },
  });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  return { account, email, store };
}

async function createStaff(storeId: string, role: $Enums.StaffRole, permissions: string[]) {
  const { account, email } = await createAccount();
  await prisma.staffMember.create({
    data: { accountId: account.id, storeId, role, permissions },
  });
  return { account, email };
}

async function issueRefreshRow(
  accountId: string,
  overrides: { expiresAt?: Date; revokedAt?: Date | null } = {},
) {
  const secret = "unit-secret-value";
  const row = await prisma.refreshToken.create({
    data: {
      accountId,
      tokenHash: bcrypt.hashSync(secret, 4),
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86_400_000),
      revokedAt: overrides.revokedAt ?? null,
    },
  });
  return formatRefreshToken(row.id, secret);
}

beforeEach(async () => {
  // DELETE instead of TRUNCATE: TRUNCATE fsyncs every table file
  // (DataFileImmediateSync), which is very slow on rotational disks.
  // Child tables first to satisfy foreign keys. The append-only ledger
  // trigger blocks DELETE, so it is disabled for the duration of the wipe.
  await prisma.$executeRaw`
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" DISABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" DISABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" DISABLE TRIGGER wallet_ledger_append_only;
    DELETE FROM "RefreshToken"; DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem";
    DELETE FROM "Order"; DELETE FROM "Discount"; DELETE FROM "CustomerGroup"; DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice";
    DELETE FROM "WalletEntry"; DELETE FROM "Payout"; DELETE FROM "StoreWallet"; DELETE FROM "BankAccount";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Category"; DELETE FROM "Unit"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "PurchaseOrderReceiptLine"; DELETE FROM "PurchaseOrderReceipt"; DELETE FROM "PurchaseOrderPayment"; DELETE FROM "PurchaseOrderLineItem"; DELETE FROM "PurchaseOrder"; DELETE FROM "Supplier";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "InviteToken"; DELETE FROM "Owner";
    DELETE FROM "StoreActivityLog";
    DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "AccountVerificationToken"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

describe("POST /api/public/auth/register (integration)", () => {
  it("creates an Account only and returns a token pair with needsOnboarding and verified: false", async () => {
    const res = await registerViaApi();

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: VALID.email,
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
    expect(res.body.accessToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(res.body.refreshToken).toMatch(/^rt_/);

    const account = await prisma.account.findUnique({ where: { email: VALID.email } });
    expect(account).not.toBeNull();
    expect(account?.firstName).toBe("Ade");
    expect(account?.lastName).toBe("Okafor");
    expect(account?.phone).toBe("+234 801 234 5678");
    expect(account?.emailVerifiedAt).toBeNull();
    // Registration never creates tenant records — that is onboarding's job.
    const owner = await prisma.owner.findUnique({ where: { accountId: account!.id } });
    expect(owner).toBeNull();
    const stores = await prisma.store.count();
    expect(stores).toBe(0);
    // A single-use verification token was issued for the account.
    const tokens = await prisma.accountVerificationToken.findMany({
      where: { accountId: account!.id },
    });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.token).toMatch(/^vrf_/);
    expect(tokens[0]!.usedAt).toBeNull();
    expect(tokens[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a duplicate email with EMAIL_TAKEN", async () => {
    await registerViaApi();

    const res = await registerViaApi({ phone: "+234 802 222 2222" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("validates input before doing anything (400 VALIDATION_ERROR)", async () => {
    const res = await registerViaApi({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");

    const res2 = await registerViaApi({ password: "short" });
    expect(res2.status).toBe(400);

    const res3 = await registerViaApi({ phone: "not-a-phone" });
    expect(res3.status).toBe(400);

    const res4 = await registerViaApi({ confirmPassword: "different-password" });
    expect(res4.status).toBe(400);

    const res5 = await registerViaApi({ firstName: "" });
    expect(res5.status).toBe(400);
  });
});

describe("POST /api/public/auth/verify (integration)", () => {
  it("verifies the account with the mailed token and persists emailVerifiedAt", async () => {
    const reg = await registerViaApi();

    const { res, token } = await verifyLatestToken(reg.body.user.email);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true });
    const account = await prisma.account.findUnique({ where: { email: reg.body.user.email } });
    expect(account?.emailVerifiedAt).not.toBeNull();
    const row = await prisma.accountVerificationToken.findUnique({ where: { token } });
    expect(row?.usedAt).not.toBeNull();
  });

  it("is idempotent for an already-verified account (re-clicked link)", async () => {
    const reg = await registerAndVerify();
    const account = await prisma.account.findUnique({ where: { email: reg.body.user.email } });
    const row = await prisma.accountVerificationToken.findFirst({
      where: { accountId: account!.id },
    });

    const res = await request(app).post("/api/public/auth/verify").send({ token: row!.token });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true });
  });

  it("rejects an unknown token with VERIFICATION_INVALID (404)", async () => {
    const res = await request(app)
      .post("/api/public/auth/verify")
      .send({ token: "vrf_unknown-not-in-the-database" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("VERIFICATION_INVALID");
  });

  it("rejects a malformed token with VALIDATION_ERROR (400)", async () => {
    const missing = await request(app).post("/api/public/auth/verify").send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("VALIDATION_ERROR");

    const wrongPrefix = await request(app)
      .post("/api/public/auth/verify")
      .send({ token: "not-a-vrf-token" });
    expect(wrongPrefix.status).toBe(400);
    expect(wrongPrefix.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("verifying enables onboarding without a new login (same session works)", async () => {
    const reg = await registerViaApi();
    const blocked = await onboardViaApi(reg.body.accessToken, ONBOARD_PROFILE);
    expect(blocked.status).toBe(403);

    await verifyLatestToken(reg.body.user.email);

    const accepted = await onboardViaApi(reg.body.accessToken, ONBOARD_PROFILE);
    expect(accepted.status).toBe(201);
    const me = await request(app)
      .get("/api/dashboard/me")
      .set("Authorization", `Bearer ${reg.body.accessToken}`);
    expect(me.body.verified).toBe(true);
    expect(me.body.needsOnboarding).toBe(false);
  });
});

describe("POST /api/dashboard/resend-verification (integration)", () => {
  it("issues a fresh token and resolves sent: true", async () => {
    // Direct-DB account: no registration token exists, so the resend
    // is not cooldown-blocked.
    const { account, email } = await createAccount();
    const login = await loginViaApi(email, "password-123");

    const res = await request(app)
      .post("/api/dashboard/resend-verification")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    const rows = await prisma.accountVerificationToken.findMany({
      where: { accountId: account.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).toMatch(/^vrf_/);
    expect(rows[0]!.usedAt).toBeNull();
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The fresh token verifies the account.
    await verifyLatestToken(email);
  });

  it("rate-limits resends to one per 60 seconds (429)", async () => {
    const { email } = await createAccount();
    const login = await loginViaApi(email, "password-123");
    const send = () =>
      request(app)
        .post("/api/dashboard/resend-verification")
        .set("Authorization", `Bearer ${login.body.accessToken}`);

    const first = await send();
    expect(first.status).toBe(200);

    const second = await send();
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("RATE_LIMITED");
  });

  it("rejects an already-verified account with ALREADY_VERIFIED (409)", async () => {
    const reg = await registerAndVerify();

    const res = await request(app)
      .post("/api/dashboard/resend-verification")
      .set("Authorization", `Bearer ${reg.body.accessToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_VERIFIED");
  });

  it("rejects unauthenticated requests (401 NEED_LOGIN)", async () => {
    const res = await request(app).post("/api/dashboard/resend-verification").send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("NEED_LOGIN");
  });
});

describe("POST /api/dashboard/onboarding (integration)", () => {
  it("creates Store + Owner atomically with the business profile and an auto-generated subdomain", async () => {
    const reg = await registerAndVerify();

    const res = await onboardViaApi(reg.body.accessToken, ONBOARD_PROFILE);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: VALID.email,
      role: "OWNER",
      storeName: "Ades Store",
      subdomain: "ades-store",
      needsOnboarding: false,
      verified: true,
    });

    const account = await prisma.account.findUnique({ where: { email: VALID.email } });
    const owner = await prisma.owner.findUnique({ where: { accountId: account!.id } });
    expect(owner).not.toBeNull();
    const store = await prisma.store.findUnique({ where: { id: owner!.storeId } });
    expect(store?.subdomain).toBe("ades-store");
    expect(store?.businessType).toBe("RETAIL");
    expect(store?.location).toBe("Lagos, Nigeria");
    expect(store?.currency).toBe("NGN");
    expect(store?.businessPhone).toBe("+234 801 234 5678");
    expect(store?.subdomain).toMatch(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/);
  });

  it("rejects onboarding before email verification (403 VERIFICATION_REQUIRED) and accepts it after", async () => {
    const reg = await registerViaApi();

    const blocked = await onboardViaApi(reg.body.accessToken, ONBOARD_PROFILE);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("VERIFICATION_REQUIRED");
    expect(await prisma.store.count()).toBe(0);

    await verifyLatestToken(reg.body.user.email);
    const accepted = await onboardViaApi(reg.body.accessToken, ONBOARD_PROFILE);
    expect(accepted.status).toBe(201);
    expect(accepted.body.user.subdomain).toBe("ades-store");
  });

  it("resolves same-name collisions with a numeric suffix instead of failing", async () => {
    const first = await registerAndVerify();
    const firstRes = await onboardViaApi(first.body.accessToken, {
      ...ONBOARD_PROFILE,
      name: "First Store",
    });
    expect(firstRes.status).toBe(201);
    expect(firstRes.body.user.subdomain).toBe("first-store");

    const secondReg = await registerViaApi({ email: "second-owner@example.com" });
    await verifyLatestToken("second-owner@example.com");
    const secondRes = await onboardViaApi(secondReg.body.accessToken, {
      ...ONBOARD_PROFILE,
      name: "First Store",
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.user.subdomain).toBe("first-store-2");

    const second = await prisma.account.findUnique({
      where: { email: "second-owner@example.com" },
    });
    const owner = await prisma.owner.findUnique({ where: { accountId: second!.id } });
    const store = await prisma.store.findUnique({ where: { id: owner!.storeId } });
    expect(store?.subdomain).toBe("first-store-2");
  });

  it("gives every store a subdomain; other subdomains still 404 at checkout", async () => {
    const reg = await registerAndVerify();

    const res = await onboardViaApi(reg.body.accessToken, ONBOARD_PROFILE);

    expect(res.status).toBe(201);
    expect(res.body.user.subdomain).toBe("ades-store");
    expect(res.body.user.needsOnboarding).toBe(false);

    // A storefront URL that matches nothing stays unreachable.
    const checkout = await request(app)
      .post("/api/public/checkout/no-such-store")
      .send({ customer: { name: "X", email: "x@example.com" }, items: [] });
    expect(checkout.status).toBe(404);
    expect(checkout.body.error.code).toBe("STORE_NOT_FOUND");
  });

  it("returns the auto-generated subdomain from /me and login", async () => {
    const reg = await registerAndVerify();
    await onboardViaApi(reg.body.accessToken, ONBOARD_PROFILE);

    const login = await loginViaApi(VALID.email, VALID.password);
    expect(login.body.user.subdomain).toBe("ades-store");
    expect(login.body.user.role).toBe("OWNER");

    const me = await request(app)
      .get("/api/dashboard/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.subdomain).toBe("ades-store");
    expect(me.body.needsOnboarding).toBe(false);
  });

  it("rejects a second onboarding with ALREADY_ONBOARDED", async () => {
    const reg = await registerAndVerify();
    await onboardViaApi(reg.body.accessToken, ONBOARD_PROFILE);

    const again = await onboardViaApi(reg.body.accessToken, ONBOARD_PROFILE);

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_ONBOARDED");
    const stores = await prisma.store.count();
    expect(stores).toBe(1);
  });

  it("rejects a name whose derived subdomain is reserved (409 SUBDOMAIN_RESERVED) and creates nothing", async () => {
    const reg = await registerAndVerify();

    const res = await onboardViaApi(reg.body.accessToken, {
      ...ONBOARD_PROFILE,
      name: "Brikoh",
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SUBDOMAIN_RESERVED");
    expect(res.body.error.message).toBe(
      "That store name isn't available — please choose a different one.",
    );
    expect(await prisma.store.count()).toBe(0);
  });

  it("rejects a name too short to derive a 4-char subdomain (409 SUBDOMAIN_TOO_SHORT)", async () => {
    const reg = await registerAndVerify();

    const res = await onboardViaApi(reg.body.accessToken, {
      ...ONBOARD_PROFILE,
      name: "Abc",
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SUBDOMAIN_TOO_SHORT");
    expect(await prisma.store.count()).toBe(0);
  });

  it("rejects store names with digits or punctuation (400 VALIDATION_ERROR)", async () => {
    const reg = await registerAndVerify();

    for (const name of ["7-Eleven", "Ade's Store"]) {
      const res = await onboardViaApi(reg.body.accessToken, { ...ONBOARD_PROFILE, name });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.message).toBe("Store name can only contain letters and spaces");
    }
    expect(await prisma.store.count()).toBe(0);
  });

  it("rejects unauthenticated requests (401 NEED_LOGIN)", async () => {
    const res = await request(app).post("/api/dashboard/onboarding").send(ONBOARD_PROFILE);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("NEED_LOGIN");
  });

  it("validates the body before doing anything (400 VALIDATION_ERROR)", async () => {
    const reg = await registerViaApi();
    const token = reg.body.accessToken;

    const badName = await onboardViaApi(token, { ...ONBOARD_PROFILE, name: "" });
    expect(badName.status).toBe(400);

    const badType = await onboardViaApi(token, { ...ONBOARD_PROFILE, businessType: "NOT_A_TYPE" });
    expect(badType.status).toBe(400);

    const badCurrency = await onboardViaApi(token, { ...ONBOARD_PROFILE, currency: "XOF" });
    expect(badCurrency.status).toBe(400);

    const badLocation = await onboardViaApi(token, { ...ONBOARD_PROFILE, location: "X" });
    expect(badLocation.status).toBe(400);

    const badPhone = await onboardViaApi(token, { ...ONBOARD_PROFILE, businessPhone: "nope" });
    expect(badPhone.status).toBe(400);

    // The shape is strict: a stale client still sending the removed
    // website question is rejected, never silently stripped.
    const staleClient = await onboardViaApi(token, {
      ...ONBOARD_PROFILE,
      wantWebsite: true,
      subdomain: "ades-store",
    });
    expect(staleClient.status).toBe(400);
    expect(staleClient.body.error.code).toBe("VALIDATION_ERROR");

    // Nothing was created by any of the rejected requests.
    expect(await prisma.store.count()).toBe(0);
  });
});

describe("POST /api/public/auth/login (integration)", () => {
  it("logs in the owner and issues tokens with correct claims", async () => {
    await registerAndOnboard();

    const res = await loginViaApi(VALID.email, VALID.password);

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("OWNER");
    expect(res.body.user.needsOnboarding).toBe(false);
    const payload = jwt.verify(res.body.accessToken, env.JWT_SECRET) as {
      sub: string;
      storeId: string;
      role: string;
    };
    expect(payload.sub).toBe(res.body.user.accountId);
    expect(payload.storeId).toBe(res.body.user.storeId);
    expect(payload.role).toBe("OWNER");
  });

  it("rejects a wrong password with INVALID_CREDENTIALS", async () => {
    await registerViaApi();

    const res = await loginViaApi(VALID.email, "wrong-password");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects an unknown email with the same INVALID_CREDENTIALS code", async () => {
    const res = await loginViaApi("nobody@example.com", VALID.password);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("logs in an un-onboarded account with needsOnboarding: true", async () => {
    const { email } = await createAccount();

    const res = await loginViaApi(email, "password-123");

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBeNull();
    expect(res.body.user.storeId).toBeNull();
    expect(res.body.user.needsOnboarding).toBe(true);
  });
});

describe("POST /api/public/auth/google (integration)", () => {
  // Under NODE_ENV=test the route wires the console Google client: each
  // code maps to a deterministic identity (stub-<code>@google.test) with
  // no network calls, so the full create/link flow runs against the real
  // database.
  const REDIRECT = "https://brikoh.com/auth/google/callback";

  function googleSignInViaApi(code: string, redirectUri = REDIRECT) {
    return request(app).post("/api/public/auth/google").send({ code, redirectUri });
  }

  it("creates a Google-native account (verified, onboarding) for a new identity", async () => {
    const res = await googleSignInViaApi("newowner");

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(res.body.refreshToken).toMatch(/^rt_/);
    expect(res.body.user.email).toBe("newowner@google.test");
    expect(res.body.user.role).toBeNull();
    expect(res.body.user.storeId).toBeNull();
    expect(res.body.user.verified).toBe(true);
    expect(res.body.user.needsOnboarding).toBe(true);

    const row = await prisma.account.findUnique({
      where: { email: "newowner@google.test" },
    });
    expect(row).not.toBeNull();
    expect(row!.googleSub).toBe("stub-newowner");
    expect(row!.passwordHash).toBeNull();
    expect(row!.emailVerifiedAt).not.toBeNull();
  });

  it("links googleSub to an existing password account matched by email", async () => {
    const account = await prisma.account.create({
      data: { email: "existing@google.test", passwordHash: bcrypt.hashSync("password-123", 4) },
    });
    const res = await googleSignInViaApi("existing");

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("existing@google.test");
    expect(res.body.user.needsOnboarding).toBe(true);

    const row = await prisma.account.findUnique({ where: { id: account.id } });
    expect(row!.googleSub).toBe("stub-existing");
    // The password is untouched — Google login links the identity, it
    // does not replace the credential.
    expect(row!.passwordHash).not.toBeNull();
  });

  it("signs in an account already linked by googleSub without creating a duplicate", async () => {
    await createAccount();
    const pre = await prisma.account.create({
      data: {
        email: "linked@google.test",
        googleSub: "stub-linked",
        passwordHash: bcrypt.hashSync("password-123", 4),
      },
    });

    const res = await googleSignInViaApi("linked");

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("linked@google.test");
    const rows = await prisma.account.findMany({ where: { email: "linked@google.test" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(pre.id);
  });

  it("surfaces a rejected code as GOOGLE_AUTH_FAILED (401)", async () => {
    const res = await googleSignInViaApi("unknown-code-xyz");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("GOOGLE_AUTH_FAILED");
  });

  it("rejects an unlisted redirectUri with VALIDATION_ERROR (400)", async () => {
    const res = await googleSignInViaApi("newowner", "https://evil.example/callback");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    await expect(
      prisma.account.findUnique({ where: { email: "newowner@google.test" } }),
    ).resolves.toBeNull();
  });

  it("accepts any localhost redirectUri (dev convenience)", async () => {
    const res = await googleSignInViaApi("localdev", "http://localhost:5173/auth/google/callback");

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("localdev@google.test");
    expect(res.body.user.needsOnboarding).toBe(true);
  });

  it("rejects a deactivated staff membership with ACCOUNT_DISABLED (403)", async () => {
    const { store } = await createTenantWithOwner();
    const { account } = await createAccount();
    await prisma.staffMember.create({
      data: {
        accountId: account.id,
        storeId: store.id,
        role: "STAFF",
        permissions: ["orders.manage"],
        isActive: false,
      },
    });
    // Map the stub identity to this account so the flow resolves the
    // disabled membership instead of creating a new account.
    await prisma.account.update({
      where: { id: account.id },
      data: { email: "disabled@google.test", googleSub: "stub-disabled" },
    });

    const res = await googleSignInViaApi("disabled");

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_DISABLED");
  });

  it("password login for a Google-native account returns INVALID_CREDENTIALS", async () => {
    await prisma.account.create({
      data: {
        email: "native@google.test",
        googleSub: "stub-native",
        emailVerifiedAt: new Date(),
      },
    });

    const res = await loginViaApi("native@google.test", "password-123");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });
});

describe("POST /api/public/auth/refresh (integration)", () => {
  it("rotates the token: old token is dead, new pair works", async () => {
    await registerViaApi();
    const login = await loginViaApi(VALID.email, VALID.password);
    const raw = login.body.refreshToken;

    const rotated = await request(app).post("/api/public/auth/refresh").send({ refreshToken: raw });

    expect(rotated.status).toBe(200);
    expect(rotated.body.accessToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(rotated.body.refreshToken).toMatch(/^rt_/);
    expect(rotated.body.refreshToken).not.toBe(raw);

    const reused = await request(app).post("/api/public/auth/refresh").send({ refreshToken: raw });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe("TOKEN_REUSE_DETECTED");
  });

  it("issues an access token for the same account and store it was issued to", async () => {
    const { account, email, store } = await createTenantWithOwner();

    const login = await loginViaApi(email, "password-123");
    const rotated = await request(app)
      .post("/api/public/auth/refresh")
      .send({ refreshToken: login.body.refreshToken });

    const payload = jwt.verify(rotated.body.accessToken, env.JWT_SECRET) as {
      sub: string;
      storeId: string;
    };
    expect(payload.sub).toBe(account.id);
    expect(payload.storeId).toBe(store.id);
  });

  it("detects reuse: presenting a revoked token revokes every other active session", async () => {
    await registerViaApi();
    const session1 = await loginViaApi(VALID.email, VALID.password);
    const session2 = await loginViaApi(VALID.email, VALID.password);

    // Rotate session1, then present the now-revoked session1 token again.
    await request(app)
      .post("/api/public/auth/refresh")
      .send({ refreshToken: session1.body.refreshToken });
    const reused = await request(app)
      .post("/api/public/auth/refresh")
      .send({ refreshToken: session1.body.refreshToken });

    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe("TOKEN_REUSE_DETECTED");

    // session2 (still active before the reuse signal) must now be revoked too.
    const session2Try = await request(app)
      .post("/api/public/auth/refresh")
      .send({ refreshToken: session2.body.refreshToken });
    expect(session2Try.status).toBe(401);
  });

  it("rejects an expired token (SESSION_EXPIRED)", async () => {
    const { account } = await createTenantWithOwner();
    const raw = await issueRefreshRow(account.id, { expiresAt: new Date(Date.now() - 1000) });

    const res = await request(app).post("/api/public/auth/refresh").send({ refreshToken: raw });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_EXPIRED");
  });

  it("rejects garbage and missing tokens", async () => {
    const garbage = await request(app)
      .post("/api/public/auth/refresh")
      .send({ refreshToken: "not-a-token" });
    expect(garbage.status).toBe(401);
    expect(garbage.body.error.code).toBe("INVALID_REFRESH_TOKEN");

    const missing = await request(app).post("/api/public/auth/refresh").send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("handles concurrent refresh attempts: exactly one wins", async () => {
    await registerViaApi();
    const login = await loginViaApi(VALID.email, VALID.password);
    const raw = login.body.refreshToken;

    const [a, b] = await Promise.all([
      request(app).post("/api/public/auth/refresh").send({ refreshToken: raw }),
      request(app).post("/api/public/auth/refresh").send({ refreshToken: raw }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);

    // The loser is a reuse signal and revokes every other active session.
    // Depending on interleaving it either sweeps everything (0 left) or
    // finishes before the winner's fresh token lands (1 left) — never
    // more than the winner's single session.
    const activeRows = await prisma.refreshToken.count({
      where: { accountId: login.body.user.accountId, revokedAt: null },
    });
    expect(activeRows).toBeLessThanOrEqual(1);
  });

  it("rotates a token for an un-onboarded account (session survives onboarding)", async () => {
    const { email } = await createAccount();
    const login = await loginViaApi(email, "password-123");

    const rotated = await request(app)
      .post("/api/public/auth/refresh")
      .send({ refreshToken: login.body.refreshToken });

    expect(rotated.status).toBe(200);
    const payload = jwt.verify(rotated.body.accessToken, env.JWT_SECRET) as {
      sub: string;
      storeId?: string;
    };
    expect(payload.sub).toBe(login.body.user.accountId);
    expect(payload.storeId).toBeUndefined();
  });

  it("rejects a token for a deleted account", async () => {
    const { account, email } = await createTenantWithOwner();
    const login = await loginViaApi(email, "password-123");
    // Owner restricts Account deletion; remove the membership rows first.
    await prisma.owner.deleteMany({ where: { accountId: account.id } });
    await prisma.account.delete({ where: { id: account.id } });

    const res = await request(app)
      .post("/api/public/auth/refresh")
      .send({ refreshToken: login.body.refreshToken });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });
});

describe("POST /api/public/auth/logout (integration)", () => {
  it("revokes the token so refresh fails afterwards, and is idempotent", async () => {
    await registerViaApi();
    const login = await loginViaApi(VALID.email, VALID.password);

    const logout = await request(app)
      .post("/api/public/auth/logout")
      .send({ refreshToken: login.body.refreshToken });
    expect(logout.status).toBe(204);

    const again = await request(app)
      .post("/api/public/auth/logout")
      .send({ refreshToken: login.body.refreshToken });
    expect(again.status).toBe(204);

    const refresh = await request(app)
      .post("/api/public/auth/refresh")
      .send({ refreshToken: login.body.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it("rejects a malformed token with VALIDATION_ERROR", async () => {
    const res = await request(app)
      .post("/api/public/auth/logout")
      .send({ refreshToken: "garbage" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/dashboard/me (integration)", () => {
  it("returns the owner's account and tenant context", async () => {
    await registerAndOnboard();
    const login = await loginViaApi(VALID.email, VALID.password);

    const res = await request(app)
      .get("/api/dashboard/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: VALID.email,
      firstName: "Ade",
      lastName: "Okafor",
      role: "OWNER",
      needsOnboarding: false,
      verified: true,
    });
    expect(res.body.permissions).toEqual([...PERMISSIONS]);
  });

  it("returns a staff member's context with their permissions", async () => {
    const { store } = await createTenantWithOwner();
    const { email } = await createStaff(store.id, "MANAGER", ["orders.manage"]);

    const login = await loginViaApi(email, "password-123");
    const res = await request(app)
      .get("/api/dashboard/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.role).toBe("MANAGER");
    expect(res.body.permissions).toEqual(["orders.manage"]);
    expect(res.body.storeId).toBe(store.id);
  });

  it("rejects missing, garbage, and expired tokens with distinct codes", async () => {
    const missing = await request(app).get("/api/dashboard/me");
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("NEED_LOGIN");

    const garbage = await request(app)
      .get("/api/dashboard/me")
      .set("Authorization", "Bearer not-a-jwt");
    expect(garbage.status).toBe(401);
    expect(garbage.body.error.code).toBe("INVALID_TOKEN");

    const expired = signAccessToken({ sub: "account-1", role: "OWNER" }, "-5s");
    const expiredRes = await request(app)
      .get("/api/dashboard/me")
      .set("Authorization", `Bearer ${expired}`);
    expect(expiredRes.status).toBe(401);
    expect(expiredRes.body.error.code).toBe("SESSION_EXPIRED");
  });

  it("returns needsOnboarding and verified: false for an un-onboarded account", async () => {
    const { email } = await createAccount();
    const login = await loginViaApi(email, "password-123");

    const res = await request(app)
      .get("/api/dashboard/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.role).toBeNull();
    expect(res.body.storeId).toBeNull();
    expect(res.body.needsOnboarding).toBe(true);
    expect(res.body.verified).toBe(false);
    expect(res.body.permissions).toEqual([]);
  });

  it("returns needsOnboarding for an account that lost its ownership", async () => {
    const { account, email } = await createTenantWithOwner();
    const login = await loginViaApi(email, "password-123");
    await prisma.owner.deleteMany({ where: { accountId: account.id } });

    const res = await request(app)
      .get("/api/dashboard/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.needsOnboarding).toBe(true);
    expect(res.body.role).toBeNull();
  });

  it("never lets a client-supplied value override the token's tenant (cross-tenant)", async () => {
    const { account, email, store } = await createTenantWithOwner();
    const { store: storeB } = await createTenantWithOwner();

    const login = await loginViaApi(email, "password-123");

    const res = await request(app)
      .get("/api/dashboard/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .set("X-Store-Id", storeB.id)
      .query({ storeId: storeB.id })
      .send({ storeId: storeB.id });

    expect(res.status).toBe(200);
    expect(res.body.storeId).toBe(store.id);
    expect(res.body.storeId).not.toBe(storeB.id);
    expect(res.body.accountId).toBe(account.id);
  });
});

describe("authorize guard (integration)", () => {
  function buildGuardApp(permission: string) {
    const guarded = express();
    guarded.use(express.json());
    guarded.get("/guard", authenticate, resolveTenant, authorize(permission), (_req, res) => {
      res.json({ ok: true });
    });
    guarded.use(errorHandler);
    return guarded;
  }

  it("lets an owner through any permission", async () => {
    const { email } = await createTenantWithOwner();
    const login = await loginViaApi(email, "password-123");

    const res = await request(buildGuardApp("products.manage"))
      .get("/guard")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
  });

  it("lets a staff member through with the permission", async () => {
    const { store } = await createTenantWithOwner();
    const { email } = await createStaff(store.id, "STAFF", ["orders.manage"]);
    const login = await loginViaApi(email, "password-123");

    const res = await request(buildGuardApp("orders.manage"))
      .get("/guard")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
  });

  it("rejects a staff member without the permission (403 ACCESS_DENIED)", async () => {
    const { store } = await createTenantWithOwner();
    const { email } = await createStaff(store.id, "STAFF", []);
    const login = await loginViaApi(email, "password-123");

    const res = await request(buildGuardApp("orders.manage"))
      .get("/guard")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });
});

describe("password change revokes sessions (integration)", () => {
  it("revokes every refresh token and flips the password", async () => {
    const { account, email } = await createTenantWithOwner();
    await loginViaApi(email, "password-123");
    const session2 = await loginViaApi(email, "password-123");

    await changePassword(account.id, {
      currentPassword: "password-123",
      newPassword: "new-password-456",
      confirmPassword: "new-password-456",
    });

    const oldLogin = await loginViaApi(email, "password-123");
    expect(oldLogin.status).toBe(401);

    const newLogin = await loginViaApi(email, "new-password-456");
    expect(newLogin.status).toBe(200);

    const active = await prisma.refreshToken.count({
      where: { accountId: account.id, revokedAt: null },
    });
    expect(active).toBe(1); // only the post-change login session

    // Presenting a token that password change revoked is a reuse signal:
    // every remaining session (including the fresh login) is revoked.
    const session2Try = await request(app)
      .post("/api/public/auth/refresh")
      .send({ refreshToken: session2.body.refreshToken });
    expect(session2Try.status).toBe(401);
    expect(session2Try.body.error.code).toBe("TOKEN_REUSE_DETECTED");

    const afterReuse = await prisma.refreshToken.count({
      where: { accountId: account.id, revokedAt: null },
    });
    expect(afterReuse).toBe(0);
  });
});

describe("token cleanup (integration)", () => {
  it("deletes expired pending invites but never accepted ones or valid ones", async () => {
    const { store } = await createTenantWithOwner();
    await prisma.inviteToken.createMany({
      data: [
        {
          token: `expired-pending-${crypto.randomUUID()}`,
          email: "a@example.com",
          storeId: store.id,
          role: "STAFF",
          status: "PENDING",
          expiresAt: new Date(Date.now() - 1000),
        },
        {
          token: `expired-accepted-${crypto.randomUUID()}`,
          email: "b@example.com",
          storeId: store.id,
          role: "STAFF",
          status: "ACCEPTED",
          expiresAt: new Date(Date.now() - 1000),
        },
        {
          token: `valid-pending-${crypto.randomUUID()}`,
          email: "c@example.com",
          storeId: store.id,
          role: "STAFF",
          status: "PENDING",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
    });

    const result = await deleteExpiredInviteTokens();

    expect(result.count).toBe(1);
    const remaining = await prisma.inviteToken.findMany({ select: { status: true } });
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => r.status).sort()).toEqual(["ACCEPTED", "PENDING"]);
  });

  it("deletes expired and long-revoked refresh tokens but keeps recent revocations", async () => {
    const { account } = await createTenantWithOwner();
    await prisma.refreshToken.createMany({
      data: [
        { accountId: account.id, tokenHash: "h", expiresAt: new Date(Date.now() - 1000) },
        {
          accountId: account.id,
          tokenHash: "h",
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: new Date(Date.now() - 31 * 86_400_000),
        },
        {
          accountId: account.id,
          tokenHash: "h",
          expiresAt: new Date(Date.now() + 86_400_000),
          revokedAt: new Date(Date.now() - 1000),
        },
        { accountId: account.id, tokenHash: "h", expiresAt: new Date(Date.now() + 86_400_000) },
      ],
    });

    const result = await deleteExpiredRefreshTokens();

    expect(result.count).toBe(2);
    const remaining = await prisma.refreshToken.count();
    expect(remaining).toBe(2);
  });

  it("deletes expired and used verification tokens but keeps valid unused ones", async () => {
    const { account } = await createAccount();
    await prisma.accountVerificationToken.createMany({
      data: [
        {
          token: `vrf_expired-${crypto.randomUUID().slice(0, 20)}`,
          accountId: account.id,
          expiresAt: new Date(Date.now() - 1000),
        },
        {
          token: `vrf_used-${crypto.randomUUID().slice(0, 20)}`,
          accountId: account.id,
          expiresAt: new Date(Date.now() + 86_400_000),
          usedAt: new Date(Date.now() - 1000),
        },
        {
          token: `vrf_valid-${crypto.randomUUID().slice(0, 20)}`,
          accountId: account.id,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
    });

    const result = await deleteExpiredVerificationTokens();

    expect(result.count).toBe(2);
    const remaining = await prisma.accountVerificationToken.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.token).toMatch(/^vrf_valid-/);
  });

  it("is safe to call twice in a row", async () => {
    const first = await deleteExpiredInviteTokens();
    const second = await deleteExpiredInviteTokens();
    const third = await deleteExpiredRefreshTokens();
    expect(first.count).toBeGreaterThanOrEqual(0);
    expect(second.count).toBe(0);
    expect(third.count).toBeGreaterThanOrEqual(0);
  });
});

describe("settings & account routes (integration)", () => {
  it("changes the password through the authenticated route and revokes other sessions", async () => {
    const { account, email } = await createTenantWithOwner();
    const login = await loginViaApi(email, "password-123");
    const stale = await loginViaApi(email, "password-123");

    const res = await request(app)
      .post("/api/dashboard/settings/password")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({
        currentPassword: "password-123",
        newPassword: "new-password-456",
        confirmPassword: "new-password-456",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const active = await prisma.refreshToken.count({
      where: { accountId: account.id, revokedAt: null },
    });
    expect(active).toBe(0);
    const staleUse = await request(app)
      .post("/api/public/auth/refresh")
      .send({ refreshToken: stale.body.refreshToken });
    expect(staleUse.status).toBe(401);
  });

  it("rejects a mismatched confirmPassword on the password route", async () => {
    const { email } = await createTenantWithOwner();
    const login = await loginViaApi(email, "password-123");

    const res = await request(app)
      .post("/api/dashboard/settings/password")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({
        currentPassword: "password-123",
        newPassword: "new-password-456",
        confirmPassword: "different-password",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("lets the owner update the business profile via the settings route", async () => {
    const { email } = await createTenantWithOwner();
    const login = await loginViaApi(email, "password-123");

    const res = await request(app)
      .put("/api/dashboard/settings/business")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({
        name: "Rebranded Store",
        businessType: "FOOD_AND_BEVERAGE",
        location: "Abuja, Nigeria",
        currency: "NGN",
        businessPhone: "+234 802 345 6789",
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Rebranded Store", businessType: "FOOD_AND_BEVERAGE" });
  });

  it("rejects settings writes from staff (owner-only)", async () => {
    const { store } = await createTenantWithOwner();
    const staff = await createStaff(store.id, "MANAGER", ["products.manage", "viewProfit"]);

    const res = await request(app)
      .put("/api/dashboard/settings/business")
      .set("Authorization", `Bearer ${signAccessToken({ sub: staff.account.id, role: "STAFF" })}`)
      .send({
        name: "Hijacked Store",
        businessType: "RETAIL",
        location: "Lagos",
        businessPhone: "+234 802 345 6789",
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });

  it("serves the overview aggregation to any tenant member", async () => {
    const { email } = await createTenantWithOwner();
    const login = await loginViaApi(email, "password-123");

    const res = await request(app)
      .get("/api/dashboard/overview")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.kpis).toEqual({
      revenue: "0.00",
      orders: 0,
      customers: 0,
      avgOrderValue: "0.00",
    });
    expect(Array.isArray(res.body.revenueTrend)).toBe(true);
    expect(res.body.recentOrders).toEqual([]);
    expect(res.body.lowStock).toEqual([]);
    expect(res.body.expiringSoon).toEqual([]);
    expect(res.body.quickStats).toMatchObject({ productCount: 0, branchCount: 0 });
  });

  it("deletes the account and its whole store", async () => {
    const { account, email, store } = await createTenantWithOwner();
    const login = await loginViaApi(email, "password-123");

    const res = await request(app)
      .delete("/api/dashboard/account")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // The Owner row carries the Restrict guard, so it must go before the
    // account; the store is removed by the service and cascades outward.
    expect(await prisma.account.findUnique({ where: { id: account.id } })).toBeNull();
    expect(await prisma.owner.findUnique({ where: { accountId: account.id } })).toBeNull();
    expect(await prisma.store.findUnique({ where: { id: store.id } })).toBeNull();
  });
});
