import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { requireOwner } from "./requireOwner.js";

function tenantRequest(tenant?: object) {
  return { tenant } as unknown as Request;
}

function mockRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
}

function nextSpy() {
  return vi.fn() as unknown as NextFunction;
}

describe("requireOwner (unit)", () => {
  it("lets an OWNER through", () => {
    const req = tenantRequest({ storeId: "store-1", role: "OWNER", permissions: [] });
    const next = nextSpy();

    requireOwner(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it("rejects a staff member even with staff.manage and every other permission", () => {
    const req = tenantRequest({
      storeId: "store-1",
      role: "ADMIN",
      permissions: ["staff.manage", "products.manage", "orders.manage"],
    });
    const next = nextSpy();

    requireOwner(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: "ACCESS_DENIED" }),
    );
  });

  it("rejects every staff role, not just ADMIN", () => {
    for (const role of ["MANAGER", "STAFF"]) {
      const req = tenantRequest({ storeId: "store-1", role, permissions: [] });
      const next = nextSpy();

      requireOwner(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 403, code: "ACCESS_DENIED" }),
      );
    }
  });

  it("rejects when no tenant context exists (never passed resolveTenant)", () => {
    const next = nextSpy();

    requireOwner(tenantRequest(), mockRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, code: "NEED_LOGIN" }),
    );
  });
});
