import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import type { PrismaClient } from "../../../generated/prisma/client.js";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

const authServiceMocks = vi.hoisted(() => ({ issueRefreshToken: vi.fn() }));
vi.mock("../auth/service.js", () => ({
  BCRYPT_COST: 12,
  issueRefreshToken: authServiceMocks.issueRefreshToken,
}));

import type { $Enums } from "../../../generated/prisma/client.js";
import {
  acceptInvite,
  createInvite,
  listPendingInvites,
  revokeInvite,
  type InviteEmailData,
  type InviteEmailSender,
} from "./invite.service.js";

type Mock = ReturnType<typeof vi.fn>;

interface TxStub {
  $queryRaw: Mock;
  account: { findUnique: Mock; create: Mock };
  staffMember: { findFirst: Mock; count: Mock; create: Mock };
  store: { findUnique: Mock };
  storeActivityLog: { create: Mock };
  inviteToken: {
    findFirst: Mock;
    update: Mock;
    create: Mock;
    findUnique: Mock;
    updateMany: Mock;
    deleteMany: Mock;
    findMany: Mock;
  };
}

const STORE_ID = "store-1";
const INVITER_EMAIL = "owner@example.com";

function createTxStub(): TxStub {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    account: { findUnique: vi.fn(), create: vi.fn() },
    staffMember: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
    store: { findUnique: vi.fn() },
    storeActivityLog: { create: vi.fn() },
    inviteToken: {
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
  };
}

function storeRow(overrides: { staffCap?: number | null; tier?: string } = {}) {
  return {
    id: STORE_ID,
    name: "Ade's Corner Store",
    subdomain: "demo",
    subscription: {
      tier: overrides.tier === undefined ? "STARTER" : overrides.tier,
      staffCap: overrides.staffCap === undefined ? 10 : overrides.staffCap,
    },
  };
}

function createSender(): InviteEmailSender & { sendInviteEmail: Mock } {
  return { sendInviteEmail: vi.fn().mockResolvedValue(undefined) };
}

let tx: TxStub;
let $transaction: Mock;
let sender: InviteEmailSender & { sendInviteEmail: Mock };

beforeEach(() => {
  tx = createTxStub();
  $transaction = vi.fn(async (fn: (t: TxStub) => Promise<unknown>) => fn(tx));
  prismaMocks.getPrismaClient.mockReturnValue({
    $transaction,
    inviteToken: tx.inviteToken,
  } as unknown as PrismaClient);
  sender = createSender();
  authServiceMocks.issueRefreshToken.mockReset();
  authServiceMocks.issueRefreshToken.mockResolvedValue("rt_refreshed");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createInvite (unit)", () => {
  it("creates a PENDING invite with a unique inv_ token and 7d expiry, then emails", async () => {
    tx.store.findUnique.mockResolvedValue(storeRow());
    tx.staffMember.count.mockResolvedValue(2);
    tx.account.findUnique.mockResolvedValue(null);
    tx.staffMember.findFirst.mockResolvedValue(null);
    tx.inviteToken.findFirst.mockResolvedValue(null);
    tx.inviteToken.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "invite-1",
        ...data,
      }),
    );

    const result = await createInvite(
      STORE_ID,
      { email: "New.Hire@Example.com", role: "MANAGER" },
      INVITER_EMAIL,
      sender,
    );

    const lockArgs = tx.$queryRaw.mock.calls[0]?.[0] as unknown[];
    expect((lockArgs as string[]).join(" ")).toContain("FOR UPDATE");
    expect(result.status).toBe("PENDING");
    expect(result.email).toBe("new.hire@example.com");
    expect(result.token).toMatch(/^inv_[A-Za-z0-9_-]{43}$/);
    expect(result.expiresInSeconds).toBe(7 * 24 * 3600);
    expect(tx.inviteToken.create).toHaveBeenCalledTimes(1);
    expect(sender.sendInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining<Partial<InviteEmailData>>({
        to: "new.hire@example.com",
        storeName: "Ade's Corner Store",
        inviterEmail: INVITER_EMAIL,
        token: result.token,
      }),
    );
    const emailData = sender.sendInviteEmail.mock.calls[0]?.[0] as InviteEmailData;
    expect(emailData.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects with STAFF_LIMIT_REACHED at the cap and creates nothing (at cap)", async () => {
    tx.store.findUnique.mockResolvedValue(storeRow({ staffCap: 2 }));
    tx.staffMember.count.mockResolvedValue(2);
    tx.account.findUnique.mockResolvedValue(null);
    tx.staffMember.findFirst.mockResolvedValue(null);

    await expect(
      createInvite(STORE_ID, { email: "hire@example.com", role: "STAFF" }, INVITER_EMAIL, sender),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "STAFF_LIMIT_REACHED",
      // The message must tell the merchant what to do next — upgrade —
      // not be a generic 500-style message.
      message: expect.stringMatching(/upgrade to PRO/i),
    });
    expect(tx.inviteToken.create).not.toHaveBeenCalled();
    expect(sender.sendInviteEmail).not.toHaveBeenCalled();
  });

  it("rejects over the cap with an upgrade-promoting message (over)", async () => {
    tx.store.findUnique.mockResolvedValue(storeRow({ staffCap: 2, tier: "PRO" }));
    tx.staffMember.count.mockResolvedValue(3);
    tx.account.findUnique.mockResolvedValue(null);
    tx.staffMember.findFirst.mockResolvedValue(null);

    const error = await createInvite(
      STORE_ID,
      { email: "hire@example.com", role: "STAFF" },
      INVITER_EMAIL,
      sender,
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toMatchObject({ statusCode: 409, code: "STAFF_LIMIT_REACHED" });
    expect((error as { message: string }).message).toMatch(/upgrade to ENTERPRISE/i);
    expect(tx.inviteToken.create).not.toHaveBeenCalled();
  });

  it("allows an invite one under the cap (boundary)", async () => {
    tx.store.findUnique.mockResolvedValue(storeRow({ staffCap: 3 }));
    tx.staffMember.count.mockResolvedValue(2);
    tx.account.findUnique.mockResolvedValue(null);
    tx.staffMember.findFirst.mockResolvedValue(null);
    tx.inviteToken.findFirst.mockResolvedValue(null);
    tx.inviteToken.create.mockResolvedValue({ id: "invite-1" });

    const result = await createInvite(
      STORE_ID,
      { email: "hire@example.com", role: "STAFF" },
      INVITER_EMAIL,
      sender,
    );
    expect(result.id).toBe("invite-1");
  });

  it("treats a null staffCap as unlimited (edge)", async () => {
    tx.store.findUnique.mockResolvedValue(storeRow({ staffCap: null }));
    tx.staffMember.count.mockResolvedValue(100);
    tx.account.findUnique.mockResolvedValue(null);
    tx.staffMember.findFirst.mockResolvedValue(null);
    tx.inviteToken.findFirst.mockResolvedValue(null);
    tx.inviteToken.create.mockResolvedValue({ id: "invite-1" });

    const result = await createInvite(
      STORE_ID,
      { email: "hire@example.com", role: "STAFF" },
      INVITER_EMAIL,
      sender,
    );
    expect(result.id).toBe("invite-1");
  });

  it("treats a missing subscription as unlimited (edge)", async () => {
    tx.store.findUnique.mockResolvedValue({ ...storeRow(), subscription: null });
    tx.staffMember.count.mockResolvedValue(100);
    tx.account.findUnique.mockResolvedValue(null);
    tx.staffMember.findFirst.mockResolvedValue(null);
    tx.inviteToken.findFirst.mockResolvedValue(null);
    tx.inviteToken.create.mockResolvedValue({ id: "invite-1" });

    const result = await createInvite(
      STORE_ID,
      { email: "hire@example.com", role: "STAFF" },
      INVITER_EMAIL,
      sender,
    );
    expect(result.id).toBe("invite-1");
  });

  it("rejects EMAIL_TAKEN when the email already belongs to an account", async () => {
    tx.account.findUnique.mockResolvedValue({ id: "account-1", email: "taken@example.com" });
    tx.store.findUnique.mockResolvedValue(storeRow());
    tx.staffMember.findFirst.mockResolvedValue(null);

    await expect(
      createInvite(STORE_ID, { email: "taken@example.com", role: "STAFF" }, INVITER_EMAIL, sender),
    ).rejects.toMatchObject({ statusCode: 409, code: "EMAIL_TAKEN" });
    expect(tx.inviteToken.create).not.toHaveBeenCalled();
  });

  it("rejects ALREADY_STAFF when the email is an active staff member of this store", async () => {
    tx.account.findUnique.mockResolvedValue(null);
    tx.store.findUnique.mockResolvedValue(storeRow());
    tx.staffMember.findFirst.mockResolvedValue({ id: "staff-9" });

    await expect(
      createInvite(STORE_ID, { email: "active@example.com", role: "STAFF" }, INVITER_EMAIL, sender),
    ).rejects.toMatchObject({ statusCode: 409, code: "ALREADY_STAFF" });
    expect(tx.inviteToken.create).not.toHaveBeenCalled();
  });

  it("invalidates a prior PENDING invite and issues a fresh one (re-invite)", async () => {
    tx.store.findUnique.mockResolvedValue(storeRow());
    tx.staffMember.count.mockResolvedValue(1);
    tx.account.findUnique.mockResolvedValue(null);
    tx.staffMember.findFirst.mockResolvedValue(null);
    tx.inviteToken.findFirst.mockResolvedValue({ id: "invite-old", status: "PENDING" });
    tx.inviteToken.create.mockResolvedValue({ id: "invite-new", token: "inv_newtoken" });

    const result = await createInvite(
      STORE_ID,
      { email: "hire@example.com", role: "ADMIN" },
      INVITER_EMAIL,
      sender,
    );

    expect(tx.inviteToken.update).toHaveBeenCalledWith({
      where: { id: "invite-old" },
      data: { status: "EXPIRED" },
    });
    expect(result.id).toBe("invite-new");
  });

  it("does not touch an ACCEPTED invite on re-invite (history preserved)", async () => {
    tx.store.findUnique.mockResolvedValue(storeRow());
    tx.staffMember.count.mockResolvedValue(1);
    tx.account.findUnique.mockResolvedValue(null);
    tx.staffMember.findFirst.mockResolvedValue(null);
    tx.inviteToken.findFirst.mockResolvedValue(null);
    tx.inviteToken.create.mockResolvedValue({ id: "invite-new" });

    await createInvite(
      STORE_ID,
      { email: "hire@example.com", role: "STAFF" },
      INVITER_EMAIL,
      sender,
    );
    expect(tx.inviteToken.update).not.toHaveBeenCalled();
  });

  it("still creates the invite and logs when email delivery fails (edge)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tx.store.findUnique.mockResolvedValue(storeRow());
    tx.staffMember.count.mockResolvedValue(1);
    tx.account.findUnique.mockResolvedValue(null);
    tx.staffMember.findFirst.mockResolvedValue(null);
    tx.inviteToken.findFirst.mockResolvedValue(null);
    tx.inviteToken.create.mockResolvedValue({ id: "invite-1", token: "inv_failed" });
    sender.sendInviteEmail.mockRejectedValue(new Error("resend 429"));

    const result = await createInvite(
      STORE_ID,
      { email: "hire@example.com", role: "STAFF" },
      INVITER_EMAIL,
      sender,
    );

    expect(result.id).toBe("invite-1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("resend 429"));
  });
});

describe("revokeInvite (unit)", () => {
  it("deletes a PENDING invite", async () => {
    tx.inviteToken.deleteMany.mockResolvedValue({ count: 1 });

    await revokeInvite(STORE_ID, "invite-1");

    expect(tx.inviteToken.deleteMany).toHaveBeenCalledWith({
      where: { id: "invite-1", storeId: STORE_ID, status: "PENDING" },
    });
  });

  it("returns 404 for an unknown, cross-store, or already-used invite", async () => {
    tx.inviteToken.deleteMany.mockResolvedValue({ count: 0 });

    await expect(revokeInvite(STORE_ID, "invite-ghost")).rejects.toMatchObject({
      statusCode: 404,
      code: "INVITE_NOT_FOUND",
    });
  });
});

describe("listPendingInvites (unit)", () => {
  it("returns only PENDING invites, oldest first", async () => {
    tx.inviteToken.findMany = vi.fn().mockResolvedValue([
      {
        id: "invite-1",
        email: "a@example.com",
        role: "ADMIN",
        status: "PENDING",
        expiresAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    const result = await listPendingInvites(STORE_ID);

    expect(result.items.map((item) => item.id)).toEqual(["invite-1"]);
    expect(tx.inviteToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: STORE_ID, status: "PENDING" } }),
    );
  });
});

describe("acceptInvite (unit)", () => {
  function pendingInvite(overrides: Record<string, unknown> = {}) {
    return {
      id: "invite-1",
      token: "inv_token",
      email: "hire@example.com",
      storeId: STORE_ID,
      role: "STAFF" as $Enums.StaffRole,
      status: "PENDING" as const,
      expiresAt: new Date(Date.now() + 60_000),
      store: { id: STORE_ID, name: "Ade's Corner Store", subdomain: "demo" },
      ...overrides,
    };
  }

  it("creates Account + StaffMember and marks the invite ACCEPTED in one transaction", async () => {
    tx.inviteToken.findUnique.mockResolvedValue(pendingInvite());
    tx.account.findUnique.mockResolvedValue(null);
    tx.account.create.mockResolvedValue({ id: "account-new", email: "hire@example.com" });
    tx.inviteToken.updateMany.mockResolvedValue({ count: 1 });
    tx.staffMember.create.mockResolvedValue({
      id: "staff-new",
      accountId: "account-new",
      storeId: STORE_ID,
      role: "STAFF",
    });

    const result = await acceptInvite({ token: "inv_token", password: "new-password-1" });

    expect(tx.inviteToken.updateMany).toHaveBeenCalledWith({
      where: { id: "invite-1", status: "PENDING" },
      data: { status: "ACCEPTED" },
    });
    expect(tx.account.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "hire@example.com" }) }),
    );
    expect(tx.staffMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accountId: expect.any(String),
          storeId: STORE_ID,
          role: "STAFF",
          permissions: ["orders.manage"],
          inviteTokenId: "invite-1",
        }),
      }),
    );
    const passwordHash = tx.account.create.mock.calls[0]?.[0].data.passwordHash as string;
    expect(await bcrypt.compare("new-password-1", passwordHash)).toBe(true);
    expect(result.user).toMatchObject({
      email: "hire@example.com",
      role: "STAFF",
      storeId: STORE_ID,
      storeName: "Ade's Corner Store",
      subdomain: "demo",
    });
    expect(result.accessToken).toMatch(/\./);
    expect(result.refreshToken).toBe("rt_refreshed");
  });

  it("rejects an unknown token with INVITE_INVALID", async () => {
    tx.inviteToken.findUnique.mockResolvedValue(null);

    await expect(
      acceptInvite({ token: "inv_ghost", password: "new-password-1" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVITE_INVALID" });
    expect(tx.inviteToken.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an already-accepted token (reuse) with INVITE_INVALID", async () => {
    tx.inviteToken.findUnique.mockResolvedValue(pendingInvite({ status: "ACCEPTED" }));

    await expect(
      acceptInvite({ token: "inv_token", password: "new-password-1" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVITE_INVALID" });
  });

  it("rejects an expired token with INVITE_EXPIRED", async () => {
    tx.inviteToken.findUnique.mockResolvedValue(
      pendingInvite({ expiresAt: new Date(Date.now() - 1) }),
    );

    await expect(
      acceptInvite({ token: "inv_token", password: "new-password-1" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVITE_EXPIRED" });
  });

  it("rejects a token whose email already has an account (edge)", async () => {
    tx.inviteToken.findUnique.mockResolvedValue(pendingInvite());
    tx.account.findUnique.mockResolvedValue({ id: "account-x", email: "hire@example.com" });

    await expect(
      acceptInvite({ token: "inv_token", password: "new-password-1" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVITE_INVALID" });
  });

  it("loses the single-use race when a concurrent accept won first", async () => {
    tx.inviteToken.findUnique.mockResolvedValue(pendingInvite());
    tx.account.findUnique.mockResolvedValue(null);
    tx.inviteToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      acceptInvite({ token: "inv_token", password: "new-password-1" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVITE_INVALID" });
  });

  it("grants role-derived default permissions for ADMIN", async () => {
    tx.inviteToken.findUnique.mockResolvedValue(pendingInvite({ role: "ADMIN" }));
    tx.account.findUnique.mockResolvedValue(null);
    tx.account.create.mockResolvedValue({ id: "account-new", email: "hire@example.com" });
    tx.inviteToken.updateMany.mockResolvedValue({ count: 1 });
    tx.staffMember.create.mockResolvedValue({ id: "staff-new" });

    await acceptInvite({ token: "inv_token", password: "new-password-1" });

    expect(tx.staffMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          permissions: [
            "products.manage",
            "orders.manage",
            "customers.manage",
            "invoices.manage",
            "purchases.manage",
            "discounts.manage",
          ],
        }),
      }),
    );
  });
});
