import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { signAccessToken } from "../../lib/tokens.js";
import { PERMISSIONS } from "../../lib/permissions.js";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/resolveTenant.js";
import { rateLimit } from "../../middleware/rateLimit.js";

function createStub() {
  return { account: { findUnique: vi.fn() } };
}

function mockRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    set: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function nextSpy() {
  return vi.fn() as unknown as NextFunction;
}

interface CallError {
  code?: string;
  statusCode?: number;
}

function errorCode(spy: NextFunction, index = 0): string {
  const calls = (spy as unknown as { mock: { calls: Array<[unknown?]> } }).mock.calls;
  const err = calls[index]?.[0] as CallError | undefined;
  return err?.code ?? "";
}

let stub: ReturnType<typeof createStub>;

beforeEach(() => {
  stub = createStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
});

describe("authenticate (unit)", () => {
  it("attaches the decoded account to req.account and continues", () => {
    const req = {
      header: vi
        .fn()
        .mockReturnValue(
          `Bearer ${signAccessToken({ sub: "account-1", storeId: "store-1", role: "OWNER" })}`,
        ),
    } as unknown as Request;
    const res = mockRes();
    const next = nextSpy();

    authenticate(req, res, next);

    expect(req.account).toEqual({
      accountId: "account-1",
      storeId: "store-1",
      role: "OWNER",
      staffMemberId: undefined,
    });
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects a missing Authorization header with 401 NEED_LOGIN", () => {
    const req = { header: vi.fn().mockReturnValue(undefined) } as unknown as Request;
    const next = nextSpy();

    authenticate(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, code: "NEED_LOGIN" }),
    );
  });

  it("rejects a non-Bearer header", () => {
    const req = { header: vi.fn().mockReturnValue("Basic abc") } as unknown as Request;
    const next = nextSpy();

    authenticate(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("rejects a garbage token", () => {
    const req = { header: vi.fn().mockReturnValue("Bearer not-a-jwt") } as unknown as Request;
    const next = nextSpy();

    authenticate(req, mockRes(), next);

    expect(errorCode(next)).toBe("INVALID_TOKEN");
  });

  it("rejects an expired token with SESSION_EXPIRED code", () => {
    const req = {
      header: vi
        .fn()
        .mockReturnValue(`Bearer ${signAccessToken({ sub: "account-1", role: "OWNER" }, "-5s")}`),
    } as unknown as Request;
    const next = nextSpy();

    authenticate(req, mockRes(), next);

    expect(errorCode(next)).toBe("SESSION_EXPIRED");
  });
});

describe("resolveTenant (unit)", () => {
  it("resolves an owner's tenant context from the database", async () => {
    stub.account.findUnique.mockResolvedValue({
      id: "account-1",
      owner: {
        id: "owner-1",
        storeId: "store-1",
        store: { id: "store-1", name: "A", subdomain: "a" },
      },
      staffMembers: [],
    });
    const req = { account: { accountId: "account-1", role: "OWNER" } } as unknown as Request;
    const next = nextSpy();

    await resolveTenant(req, mockRes(), next);

    expect(req.tenant).toEqual({
      storeId: "store-1",
      role: "OWNER",
      staffMemberId: undefined,
      permissions: [...PERMISSIONS],
    });
    expect(next).toHaveBeenCalledWith();
  });

  it("resolves a staff member's tenant context with role, id, and permissions", async () => {
    stub.account.findUnique.mockResolvedValue({
      id: "account-1",
      owner: null,
      staffMembers: [
        {
          id: "staff-1",
          storeId: "store-1",
          role: "MANAGER",
          permissions: ["orders.manage"],
          isActive: true,
          store: { id: "store-1", name: "A", subdomain: "a" },
        },
      ],
    });
    const req = { account: { accountId: "account-1", role: "MANAGER" } } as unknown as Request;
    const next = nextSpy();

    await resolveTenant(req, mockRes(), next);

    expect(req.tenant).toEqual({
      storeId: "store-1",
      role: "MANAGER",
      staffMemberId: "staff-1",
      permissions: ["orders.manage"],
    });
  });

  it("rejects an account with no membership (403 ONBOARDING_REQUIRED)", async () => {
    stub.account.findUnique.mockResolvedValue({ id: "account-1", owner: null, staffMembers: [] });
    const req = { account: { accountId: "account-1", role: "OWNER" } } as unknown as Request;
    const next = nextSpy();

    await resolveTenant(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: "ONBOARDING_REQUIRED" }),
    );
  });

  it("rejects requests that never passed authenticate (no req.account)", async () => {
    const req = {} as unknown as Request;
    const next = nextSpy();

    await resolveTenant(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});

describe("authorize (unit)", () => {
  function tenantRequest(tenant?: object) {
    return { tenant } as unknown as Request;
  }

  it("lets an OWNER pass any permission check", () => {
    const req = tenantRequest({ storeId: "store-1", role: "OWNER", permissions: [] });
    const next = nextSpy();

    authorize("products.manage")(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it("lets a staff member with the permission pass", () => {
    const req = tenantRequest({
      storeId: "store-1",
      role: "STAFF",
      permissions: ["orders.manage"],
    });
    const next = nextSpy();

    authorize("orders.manage")(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it("rejects a staff member without the permission with 403 ACCESS_DENIED", () => {
    const req = tenantRequest({ storeId: "store-1", role: "STAFF", permissions: [] });
    const next = nextSpy();

    authorize("orders.manage")(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: "ACCESS_DENIED" }),
    );
  });

  it("rejects when no tenant context exists", () => {
    const next = nextSpy();

    authorize("orders.manage")(tenantRequest(), mockRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, code: "NEED_LOGIN" }),
    );
  });
});

describe("rateLimit (unit)", () => {
  it("lets requests through under the limit and rejects past it with 429 RATE_LIMITED", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 2 });
    const req = { ip: "127.0.0.1" } as unknown as Request;
    const res = mockRes();
    const next = nextSpy();

    limiter(req, res, next);
    limiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);

    limiter(req, res, next);
    const calls = (next as unknown as { mock: { calls: Array<[unknown?]> } }).mock.calls;
    expect(calls[2]?.[0]).toEqual(
      expect.objectContaining({ statusCode: 429, code: "RATE_LIMITED" }),
    );
  });

  it("resets the window after it elapses", async () => {
    const limiter = rateLimit({ windowMs: 1, max: 1 });
    const req = { ip: "127.0.0.2" } as unknown as Request;
    const next = nextSpy();

    limiter(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith();

    await new Promise((resolve) => setTimeout(resolve, 10));
    limiter(req, mockRes(), next);
    const calls = (next as unknown as { mock: { calls: Array<[unknown?]> } }).mock.calls;
    expect(calls[1]?.[0]).toBeUndefined();
  });
});
