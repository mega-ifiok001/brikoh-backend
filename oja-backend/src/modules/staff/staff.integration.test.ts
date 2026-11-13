import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import type { $Enums } from "../../../generated/prisma/client.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

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
  const mainBranch = await prisma.branch.create({
    data: { storeId: store.id, name: "Main Branch", address: "Lagos, Nigeria" },
  });
  await prisma.store.update({ where: { id: store.id }, data: { defaultBranchId: mainBranch.id } });
  await prisma.owner.create({ data: { accountId: account.id, storeId: store.id } });
  return { account, email, store, mainBranch };
}

async function createStaff(
  storeId: string,
  role: $Enums.StaffRole,
  permissions: string[],
  emailOverride?: string,
) {
  const { account, email } = emailOverride
    ? { account: undefined, email: emailOverride }
    : await createAccount();
  const row = await prisma.staffMember.create({
    data: {
      accountId:
        account?.id ??
        (
          await prisma.account.create({
            data: { email: email!, passwordHash: bcrypt.hashSync("password-123", 4) },
          })
        ).id,
      storeId,
      role,
      permissions,
    },
  });
  return row;
}

async function setStaffCap(storeId: string, staffCap: number | null) {
  const subscription = await prisma.subscription.create({
    data: {
      storeId,
      tier: "PRO",
      status: "ACTIVE",
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      staffCap,
    },
  });
  await prisma.store.update({
    where: { id: storeId },
    data: { subscriptionId: subscription.id },
  });
}

async function ownerToken(accountId: string) {
  const res = await request(app)
    .post("/api/public/auth/login")
    .send({
      email: (await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).email,
      password: "password-123",
    });
  return res.body.accessToken as string;
}

async function staffToken(staffMemberId: string) {
  const staff = await prisma.staffMember.findUniqueOrThrow({
    where: { id: staffMemberId },
    include: { account: true },
  });
  const res = await request(app).post("/api/public/auth/login").send({
    email: staff.account.email,
    password: "password-123",
  });
  return res.body.accessToken as string;
}

async function createPendingInvite(
  storeId: string,
  email: string,
  role: $Enums.StaffRole = "STAFF",
) {
  return prisma.inviteToken.create({
    data: {
      token: `inv_test-${crypto.randomUUID()}`,
      email,
      storeId,
      role,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
}

beforeEach(async () => {
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
    DELETE FROM "Subscription"; DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "PurchaseOrderReceipt" ENABLE TRIGGER purchase_order_receipt_append_only;
    ALTER TABLE "PurchaseOrderPayment" ENABLE TRIGGER purchase_order_payment_append_only;
    ALTER TABLE "WalletEntry" ENABLE TRIGGER wallet_ledger_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

describe("GET /api/dashboard/staff (integration)", () => {
  it("lists the store's staff with emails, oldest first", async () => {
    const { store, account } = await createTenantWithOwner();
    await createStaff(store.id, "STAFF", ["orders.manage"]);
    await createStaff(store.id, "MANAGER", ["products.manage", "orders.manage"]);
    const token = await ownerToken(account.id);

    const res = await request(app)
      .get("/api/dashboard/staff")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.map((item: { role: string }) => item.role)).toEqual(["STAFF", "MANAGER"]);
    expect(res.body.items[0]).toMatchObject({
      email: expect.stringContaining("@example.com"),
      permissions: ["orders.manage"],
    });
  });

  it("rejects a staff member even with staff.manage (owner-only)", async () => {
    const { store } = await createTenantWithOwner();
    const admin = await createStaff(store.id, "ADMIN", [
      "staff.manage",
      "products.manage",
      "orders.manage",
    ]);
    const token = await staffToken(admin.id);

    const res = await request(app)
      .get("/api/dashboard/staff")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCESS_DENIED");
  });

  it("never lists another store's staff (cross-tenant)", async () => {
    const storeA = await createTenantWithOwner();
    const storeB = await createTenantWithOwner();
    await createStaff(storeB.store.id, "STAFF", []);
    const token = await ownerToken(storeA.account.id);

    const res = await request(app)
      .get("/api/dashboard/staff")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

describe("PATCH /api/dashboard/staff/:staffId (integration)", () => {
  it("updates role and permissions", async () => {
    const { store, account } = await createTenantWithOwner();
    const staff = await createStaff(store.id, "STAFF", ["orders.manage"]);
    const token = await ownerToken(account.id);

    const res = await request(app)
      .patch(`/api/dashboard/staff/${staff.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "ADMIN", permissions: ["products.manage", "orders.manage"] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      role: "ADMIN",
      permissions: ["products.manage", "orders.manage"],
    });
  });

  it("rejects an unknown permission flag (400)", async () => {
    const { store, account } = await createTenantWithOwner();
    const staff = await createStaff(store.id, "STAFF", []);
    const token = await ownerToken(account.id);

    const res = await request(app)
      .patch(`/api/dashboard/staff/${staff.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ permissions: ["billing.nuke"] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an empty body (400)", async () => {
    const { store, account } = await createTenantWithOwner();
    const staff = await createStaff(store.id, "STAFF", []);
    const token = await ownerToken(account.id);

    const res = await request(app)
      .patch(`/api/dashboard/staff/${staff.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 404 for another tenant's staff member", async () => {
    const { account } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    const foreignStaff = await createStaff(other.store.id, "STAFF", []);
    const token = await ownerToken(account.id);

    const res = await request(app)
      .patch(`/api/dashboard/staff/${foreignStaff.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "ADMIN" });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/dashboard/staff/:staffId (integration)", () => {
  it("removes the staff member and revokes their refresh tokens", async () => {
    const { store, account } = await createTenantWithOwner();
    const staff = await createStaff(store.id, "STAFF", []);
    const login = await request(app)
      .post("/api/public/auth/login")
      .send({
        email: (
          await prisma.staffMember.findUniqueOrThrow({
            where: { id: staff.id },
            include: { account: true },
          })
        ).account.email,
        password: "password-123",
      });
    const refreshBefore = login.body.refreshToken as string;
    const token = await ownerToken(account.id);

    const res = await request(app)
      .delete(`/api/dashboard/staff/${staff.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(await prisma.staffMember.findUnique({ where: { id: staff.id } })).toBeNull();

    const refreshAfter = await request(app)
      .post("/api/public/auth/refresh")
      .send({ refreshToken: refreshBefore });
    expect(refreshAfter.status).toBe(401);
  });

  it("returns 404 for another tenant's staff member", async () => {
    const { account } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    const foreignStaff = await createStaff(other.store.id, "STAFF", []);
    const token = await ownerToken(account.id);

    const res = await request(app)
      .delete(`/api/dashboard/staff/${foreignStaff.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

describe("POST /api/dashboard/staff/invites (integration)", () => {
  it("creates a PENDING InviteToken only — no Account, no StaffMember, no token in the response", async () => {
    const { account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);

    const res = await request(app)
      .post("/api/dashboard/staff/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "hire@example.com", role: "MANAGER" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      email: "hire@example.com",
      role: "MANAGER",
      status: "PENDING",
    });
    expect(res.body.expiresInSeconds).toBe(7 * 24 * 3600);
    expect(res.body.token).toBeUndefined();

    const invite = await prisma.inviteToken.findUnique({ where: { id: res.body.id } });
    expect(invite?.token).toMatch(/^inv_/);
    expect(await prisma.account.count({ where: { email: "hire@example.com" } })).toBe(0);
    expect(await prisma.staffMember.count()).toBe(0);
  });

  it("enforces the staffCap: at cap -> 409, one under -> 201, next over -> 409", async () => {
    const { store, account } = await createTenantWithOwner();
    await setStaffCap(store.id, 2);
    await createStaff(store.id, "STAFF", []);
    await createStaff(store.id, "STAFF", []);
    const token = await ownerToken(account.id);

    const atCap = await request(app)
      .post("/api/dashboard/staff/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "at-cap@example.com", role: "STAFF" });
    expect(atCap.status).toBe(409);
    expect(atCap.body.error.code).toBe("STAFF_LIMIT_REACHED");

    await prisma.staffMember.deleteMany({ where: { storeId: store.id } });
    await createStaff(store.id, "STAFF", []);

    const oneUnder = await request(app)
      .post("/api/dashboard/staff/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "one-under@example.com", role: "STAFF" });
    expect(oneUnder.status).toBe(201);

    await createStaff(store.id, "STAFF", []);

    const over = await request(app)
      .post("/api/dashboard/staff/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "over@example.com", role: "STAFF" });
    expect(over.status).toBe(409);
  });

  it("allows inviting when the subscription has a null staffCap (unlimited)", async () => {
    const { store, account } = await createTenantWithOwner();
    await setStaffCap(store.id, null);
    const token = await ownerToken(account.id);

    const res = await request(app)
      .post("/api/dashboard/staff/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "hire@example.com", role: "STAFF" });

    expect(res.status).toBe(201);
  });

  it("lets two concurrent invites through at the cap with zero staff (pending invites do not consume capacity)", async () => {
    const { store, account } = await createTenantWithOwner();
    await setStaffCap(store.id, 1);
    const token = await ownerToken(account.id);

    const [a, b] = await Promise.allSettled([
      request(app)
        .post("/api/dashboard/staff/invites")
        .set("Authorization", `Bearer ${token}`)
        .send({ email: "a@example.com", role: "STAFF" }),
      request(app)
        .post("/api/dashboard/staff/invites")
        .set("Authorization", `Bearer ${token}`)
        .send({ email: "b@example.com", role: "STAFF" }),
    ]);

    const statuses = [a, b].map((r) => (r.status === "fulfilled" ? r.value.status : -1)).sort();
    expect(statuses).toEqual([201, 201]);
    expect(await prisma.inviteToken.count({ where: { storeId: store.id } })).toBe(2);
  });

  it("rejects every concurrent invite when staff is already at the cap", async () => {
    const { store, account } = await createTenantWithOwner();
    await setStaffCap(store.id, 1);
    await createStaff(store.id, "STAFF", []);
    const token = await ownerToken(account.id);

    const [a, b] = await Promise.allSettled([
      request(app)
        .post("/api/dashboard/staff/invites")
        .set("Authorization", `Bearer ${token}`)
        .send({ email: "a@example.com", role: "STAFF" }),
      request(app)
        .post("/api/dashboard/staff/invites")
        .set("Authorization", `Bearer ${token}`)
        .send({ email: "b@example.com", role: "STAFF" }),
    ]);

    const statuses = [a, b].map((r) => (r.status === "fulfilled" ? r.value.status : -1)).sort();
    expect(statuses).toEqual([409, 409]);
    expect(await prisma.inviteToken.count({ where: { storeId: store.id } })).toBe(0);
  });

  it("rejects EMAIL_TAKEN for an email that already has an account", async () => {
    const { account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);

    const res = await request(app)
      .post("/api/dashboard/staff/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: account.email, role: "STAFF" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("rejects ALREADY_STAFF for an active staff member's email", async () => {
    const { store, account } = await createTenantWithOwner();
    const staff = await createStaff(store.id, "STAFF", []);
    const token = await ownerToken(account.id);

    const res = await request(app)
      .post("/api/dashboard/staff/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({
        email: (
          await prisma.staffMember.findUniqueOrThrow({
            where: { id: staff.id },
            include: { account: true },
          })
        ).account.email,
        role: "STAFF",
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_STAFF");
  });

  it("re-invites the same email: old invite EXPIRED, one fresh PENDING", async () => {
    const { store, account } = await createTenantWithOwner();
    const token = await ownerToken(account.id);
    const first = await request(app)
      .post("/api/dashboard/staff/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "hire@example.com", role: "STAFF" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/dashboard/staff/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "hire@example.com", role: "ADMIN" });

    expect(second.status).toBe(201);
    expect(second.body.role).toBe("ADMIN");
    const rows = await prisma.inviteToken.findMany({
      where: { storeId: store.id, email: "hire@example.com" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("EXPIRED");
    expect(rows[1]?.status).toBe("PENDING");
  });

  it("rejects a staff member caller with 403", async () => {
    const { store } = await createTenantWithOwner();
    const admin = await createStaff(store.id, "ADMIN", ["staff.manage"]);
    const token = await staffToken(admin.id);

    const res = await request(app)
      .post("/api/dashboard/staff/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "hire@example.com", role: "STAFF" });

    expect(res.status).toBe(403);
  });
});

describe("GET/DELETE /api/dashboard/staff/invites (integration)", () => {
  it("lists only pending invites", async () => {
    const { store, account } = await createTenantWithOwner();
    await createPendingInvite(store.id, "pending@example.com");
    await prisma.inviteToken.create({
      data: {
        token: "inv_accepted-1",
        email: "accepted@example.com",
        storeId: store.id,
        role: "STAFF",
        status: "ACCEPTED",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const token = await ownerToken(account.id);

    const res = await request(app)
      .get("/api/dashboard/staff/invites")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { email: string }) => item.email)).toEqual([
      "pending@example.com",
    ]);
  });

  it("revokes a pending invite (204) and 404s on the second attempt", async () => {
    const { store, account } = await createTenantWithOwner();
    const invite = await createPendingInvite(store.id, "pending@example.com");
    const token = await ownerToken(account.id);

    const first = await request(app)
      .delete(`/api/dashboard/staff/invites/${invite.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(204);
    expect(await prisma.inviteToken.findUnique({ where: { id: invite.id } })).toBeNull();

    const second = await request(app)
      .delete(`/api/dashboard/staff/invites/${invite.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(404);
  });

  it("cannot revoke another store's invite (404)", async () => {
    const { account } = await createTenantWithOwner();
    const other = await createTenantWithOwner();
    const foreign = await createPendingInvite(other.store.id, "pending@example.com");
    const token = await ownerToken(account.id);

    const res = await request(app)
      .delete(`/api/dashboard/staff/invites/${foreign.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

describe("POST /api/public/auth/accept-invite (integration)", () => {
  it("creates Account + StaffMember, marks the invite ACCEPTED, and logs the user in", async () => {
    const { store } = await createTenantWithOwner();
    const invite = await createPendingInvite(store.id, "hire@example.com", "MANAGER");

    const res = await request(app).post("/api/public/auth/accept-invite").send({
      token: invite.token,
      password: "new-password-1",
    });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: "hire@example.com",
      role: "MANAGER",
      storeId: store.id,
      storeName: store.name,
      subdomain: store.subdomain,
    });
    expect(res.body.accessToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(res.body.refreshToken).toMatch(/^rt_/);

    const account = await prisma.account.findUnique({ where: { email: "hire@example.com" } });
    expect(account).not.toBeNull();
    expect(await bcrypt.compare("new-password-1", account!.passwordHash ?? "")).toBe(true);
    const staff = await prisma.staffMember.findFirst({ where: { storeId: store.id } });
    expect(staff?.role).toBe("MANAGER");
    expect(staff?.permissions).toEqual(["products.manage", "orders.manage"]);
    expect(staff?.inviteTokenId).toBe(invite.id);
    expect((await prisma.inviteToken.findUnique({ where: { id: invite.id } }))?.status).toBe(
      "ACCEPTED",
    );

    const login = await request(app)
      .post("/api/public/auth/login")
      .send({ email: "hire@example.com", password: "new-password-1" });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe("MANAGER");
  });

  it("works without any Authorization header (public endpoint)", async () => {
    const { store } = await createTenantWithOwner();
    const invite = await createPendingInvite(store.id, "hire@example.com");

    const res = await request(app).post("/api/public/auth/accept-invite").send({
      token: invite.token,
      password: "new-password-1",
    });

    expect(res.status).toBe(201);
  });

  it("rejects an unknown token with INVITE_INVALID", async () => {
    const res = await request(app).post("/api/public/auth/accept-invite").send({
      token: "inv_does-not-exist",
      password: "new-password-1",
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVITE_INVALID");
  });

  it("rejects an expired token with INVITE_EXPIRED", async () => {
    const { store } = await createTenantWithOwner();
    const invite = await prisma.inviteToken.create({
      data: {
        token: "inv_expired-1",
        email: "late@example.com",
        storeId: store.id,
        role: "STAFF",
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    const res = await request(app).post("/api/public/auth/accept-invite").send({
      token: invite.token,
      password: "new-password-1",
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVITE_EXPIRED");
    expect(await prisma.account.count({ where: { email: "late@example.com" } })).toBe(0);
  });

  it("rejects a reused (already accepted) token with INVITE_INVALID", async () => {
    const { store } = await createTenantWithOwner();
    const invite = await createPendingInvite(store.id, "hire@example.com");

    const first = await request(app).post("/api/public/auth/accept-invite").send({
      token: invite.token,
      password: "new-password-1",
    });
    expect(first.status).toBe(201);

    const second = await request(app).post("/api/public/auth/accept-invite").send({
      token: invite.token,
      password: "another-password-2",
    });

    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe("INVITE_INVALID");
    expect(await prisma.account.count({ where: { email: "hire@example.com" } })).toBe(1);
    expect(await prisma.staffMember.count({ where: { storeId: store.id } })).toBe(1);
  });

  it("rejects a token whose email already has an account (edge)", async () => {
    const { store, account } = await createTenantWithOwner();
    const invite = await prisma.inviteToken.create({
      data: {
        token: "inv_edge-1",
        email: account.email,
        storeId: store.id,
        role: "STAFF",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const res = await request(app).post("/api/public/auth/accept-invite").send({
      token: invite.token,
      password: "new-password-1",
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVITE_INVALID");
  });

  it("lets exactly one of two concurrent accepts win (single-use race)", async () => {
    const { store } = await createTenantWithOwner();
    const invite = await createPendingInvite(store.id, "hire@example.com");

    const [a, b] = await Promise.allSettled([
      request(app).post("/api/public/auth/accept-invite").send({
        token: invite.token,
        password: "new-password-1",
      }),
      request(app).post("/api/public/auth/accept-invite").send({
        token: invite.token,
        password: "new-password-1",
      }),
    ]);

    const statuses = [a, b].map((r) => (r.status === "fulfilled" ? r.value.status : -1)).sort();
    expect(statuses).toEqual([201, 400]);
    expect(await prisma.account.count({ where: { email: "hire@example.com" } })).toBe(1);
  });
});

describe("GET /api/public/auth/accept-invite/:token (preview)", () => {
  it("returns the invite context for a valid pending token", async () => {
    const { store, account } = await createTenantWithOwner();
    const invite = await createPendingInvite(store.id, "hire@example.com", "MANAGER");

    const res = await request(app).get(`/api/public/auth/accept-invite/${invite.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: "hire@example.com",
      storeName: store.name,
      role: "MANAGER",
      inviterEmail: account.email,
    });
    expect(res.body.expiresAt).toEqual(expect.any(String));
  });

  it("rejects an unknown token with INVITE_INVALID", async () => {
    const res = await request(app).get("/api/public/auth/accept-invite/inv_does-not-exist");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVITE_INVALID");
  });

  it("rejects an expired token with INVITE_EXPIRED", async () => {
    const { store } = await createTenantWithOwner();
    const invite = await prisma.inviteToken.create({
      data: {
        token: "inv_preview-expired",
        email: "late@example.com",
        storeId: store.id,
        role: "STAFF",
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    const res = await request(app).get(`/api/public/auth/accept-invite/${invite.token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVITE_EXPIRED");
  });

  it("rejects an already-accepted token with INVITE_INVALID", async () => {
    const { store } = await createTenantWithOwner();
    const invite = await createPendingInvite(store.id, "hire@example.com");

    await request(app)
      .post("/api/public/auth/accept-invite")
      .send({ token: invite.token, password: "new-password-1" });
    expect((await prisma.inviteToken.findUnique({ where: { id: invite.id } }))?.status).toBe(
      "ACCEPTED",
    );

    const res = await request(app).get(`/api/public/auth/accept-invite/${invite.token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVITE_INVALID");
  });

  it("works without any Authorization header (public endpoint)", async () => {
    const { store } = await createTenantWithOwner();
    const invite = await createPendingInvite(store.id, "hire@example.com");

    const res = await request(app).get(`/api/public/auth/accept-invite/${invite.token}`);
    expect(res.status).toBe(200);
  });
});

describe("invited staff ledger attribution (integration)", () => {
  it("attributes an invited staff member's stock adjustment to their StaffMember id", async () => {
    const { store, mainBranch } = await createTenantWithOwner();
    // ADMIN gets products.manage by default (ROLE_DEFAULT_PERMISSIONS) —
    // the permission required to post stock adjustments.
    const invite = await createPendingInvite(store.id, "hire@example.com", "ADMIN");

    const accepted = await request(app).post("/api/public/auth/accept-invite").send({
      token: invite.token,
      password: "new-password-1",
    });
    expect(accepted.status).toBe(201);
    const staffMemberId = accepted.body.user.staffMemberId as string;
    const staffAccessToken = accepted.body.accessToken as string;

    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: `Attributed ${crypto.randomUUID().slice(0, 8)}`,
        price: 9.99,
        quantity: 10,
      },
    });
    await prisma.branchStock.create({
      data: {
        storeId: store.id,
        branchId: mainBranch.id,
        productId: product.id,
        variantId: null,
        quantity: 10,
      },
    });

    const res = await request(app)
      .post(`/api/dashboard/products/${product.id}/stock-adjustments`)
      .set("Authorization", `Bearer ${staffAccessToken}`)
      .send({ branchId: mainBranch.id, quantityChange: 2, reason: "RESTOCK" });

    expect(res.status).toBe(200);
    expect(res.body.ledgerEntry.performedByStaffId).toBe(staffMemberId);

    const ledgerRow = await prisma.stockLedgerEntry.findFirst({
      where: { productId: product.id },
    });
    expect(ledgerRow?.performedByStaffId).toBe(staffMemberId);
  });
});

describe("staff lifecycle and 'all' wildcard (integration)", () => {
  it("deactivates a member, revokes sessions, and blocks login with ACCOUNT_DISABLED", async () => {
    const { store, account } = await createTenantWithOwner();
    const staff = await createStaff(store.id, "STAFF", ["orders.manage"]);
    const ownerTok = await ownerToken(account.id);

    // Member logs in and holds a live session.
    const memberLogin = await request(app)
      .post("/api/public/auth/login")
      .send({
        email: (await prisma.account.findUniqueOrThrow({ where: { id: staff.accountId } })).email,
        password: "password-123",
      });
    expect(memberLogin.status).toBe(200);
    const memberToken = memberLogin.body.accessToken as string;
    const memberRefresh = memberLogin.body.refreshToken as string;

    const deactivate = await request(app)
      .patch(`/api/dashboard/staff/${staff.id}`)
      .set("Authorization", `Bearer ${ownerTok}`)
      .send({ isActive: false });
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.isActive).toBe(false);
    const row = await prisma.staffMember.findUniqueOrThrow({ where: { id: staff.id } });
    expect(row.isActive).toBe(false);

    // Refreshing the captured session fails — the refresh token was revoked.
    const refresh = await request(app).post("/api/public/auth/refresh").send({
      refreshToken: memberRefresh,
    });
    expect(refresh.status).toBe(401);

    // The pre-deactivation access token is dead at the middleware.
    const withOldToken = await request(app)
      .get("/api/dashboard/analytics/channels")
      .query({ start: "2026-08-01T00:00:00.000Z", end: "2026-08-20T00:00:00.000Z" })
      .set("Authorization", `Bearer ${memberToken}`);
    expect(withOldToken.status).toBe(403);
    expect(withOldToken.body.error.code).toBe("ACCOUNT_DISABLED");

    // New logins are rejected too.
    const loginAfter = await request(app)
      .post("/api/public/auth/login")
      .send({
        email: (await prisma.account.findUniqueOrThrow({ where: { id: staff.accountId } })).email,
        password: "password-123",
      });
    expect(loginAfter.status).toBe(403);
    expect(loginAfter.body.error.code).toBe("ACCOUNT_DISABLED");
  });

  it("reactivates a member and restores login", async () => {
    const { store, account } = await createTenantWithOwner();
    const staff = await createStaff(store.id, "STAFF", ["orders.manage"]);
    const ownerTok = await ownerToken(account.id);

    await request(app)
      .patch(`/api/dashboard/staff/${staff.id}`)
      .set("Authorization", `Bearer ${ownerTok}`)
      .send({ isActive: false });

    const reactivate = await request(app)
      .patch(`/api/dashboard/staff/${staff.id}`)
      .set("Authorization", `Bearer ${ownerTok}`)
      .send({ isActive: true });
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.isActive).toBe(true);

    const login = await request(app)
      .post("/api/public/auth/login")
      .send({
        email: (await prisma.account.findUniqueOrThrow({ where: { id: staff.accountId } })).email,
        password: "password-123",
      });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe("STAFF");
  });

  it("treats the 'all' wildcard as the full permission set", async () => {
    const { store, account } = await createTenantWithOwner();
    const staff = await createStaff(store.id, "STAFF", ["all"]);
    const ownerTok = await ownerToken(account.id);
    // Advanced analytics needs an active subscription tier gate.
    const subscription = await prisma.subscription.create({
      data: {
        storeId: store.id,
        tier: "PRO",
        status: "ACTIVE",
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    await prisma.store.update({
      where: { id: store.id },
      data: { subscriptionId: subscription.id },
    });

    const res = await request(app)
      .patch(`/api/dashboard/staff/${staff.id}`)
      .set("Authorization", `Bearer ${ownerTok}`)
      .send({ permissions: ["all"] });
    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual(["all"]);

    const memberLogin = await request(app)
      .post("/api/public/auth/login")
      .send({
        email: (await prisma.account.findUniqueOrThrow({ where: { id: staff.accountId } })).email,
        password: "password-123",
      });
    const memberToken = memberLogin.body.accessToken as string;

    const analytics = await request(app)
      .get("/api/dashboard/analytics/channels")
      .query({ start: "2026-08-01T00:00:00.000Z", end: "2026-08-20T00:00:00.000Z" })
      .set("Authorization", `Bearer ${memberToken}`);
    expect(analytics.status).toBe(200);

    // A member WITHOUT the wildcard and without analytics.manage is still denied.
    const limited = await createStaff(store.id, "STAFF", ["orders.manage"]);
    const limitedLogin = await request(app)
      .post("/api/public/auth/login")
      .send({
        email: (await prisma.account.findUniqueOrThrow({ where: { id: limited.accountId } })).email,
        password: "password-123",
      });
    const denied = await request(app)
      .get("/api/dashboard/analytics/channels")
      .query({ start: "2026-08-01T00:00:00.000Z", end: "2026-08-20T00:00:00.000Z" })
      .set("Authorization", `Bearer ${limitedLogin.body.accessToken}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("ACCESS_DENIED");
  });
});
