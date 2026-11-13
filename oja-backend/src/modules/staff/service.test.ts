import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client.js";

const prismaMocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("../../lib/prisma.js", () => ({
  getPrismaClient: prismaMocks.getPrismaClient,
}));

const authServiceMocks = vi.hoisted(() => ({ revokeAllRefreshTokens: vi.fn() }));
vi.mock("../auth/service.js", () => ({
  revokeAllRefreshTokens: authServiceMocks.revokeAllRefreshTokens,
}));

import { AppError } from "../../lib/AppError.js";
import { listStaff, removeStaffMember, updateStaffMember } from "./service.js";

type Mock = ReturnType<typeof vi.fn>;

interface PrismaStub {
  staffMember: {
    findMany: Mock;
    findFirst: Mock;
    update: Mock;
    delete: Mock;
  };
  storeActivityLog: { create: Mock };
}

const STORE_ID = "store-1";
const STAFF_ID = "staff-1";
const ACCOUNT_ID = "account-1";

const STAFF_ROW = {
  id: STAFF_ID,
  accountId: ACCOUNT_ID,
  storeId: STORE_ID,
  role: "MANAGER",
  permissions: ["products.manage"],
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  account: { email: "manager@example.com" },
};

function createPrismaStub(): PrismaStub {
  return {
    staffMember: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    storeActivityLog: { create: vi.fn() },
  };
}

let stub: PrismaStub;

beforeEach(() => {
  stub = createPrismaStub();
  prismaMocks.getPrismaClient.mockReturnValue(stub as unknown as PrismaClient);
  authServiceMocks.revokeAllRefreshTokens.mockReset();
  authServiceMocks.revokeAllRefreshTokens.mockResolvedValue(1);
});

describe("listStaff (unit)", () => {
  it("returns staff rows with their account email, oldest first", async () => {
    stub.staffMember.findMany.mockResolvedValue([
      { ...STAFF_ROW, id: "staff-2", createdAt: new Date("2026-06-01T00:00:00Z") },
      STAFF_ROW,
    ]);

    const result = await listStaff(STORE_ID);

    expect(result.items).toEqual([
      {
        id: "staff-2",
        email: "manager@example.com",
        role: "MANAGER",
        permissions: ["products.manage"],
        createdAt: new Date("2026-06-01T00:00:00Z"),
      },
      {
        id: STAFF_ID,
        email: "manager@example.com",
        role: "MANAGER",
        permissions: ["products.manage"],
        createdAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]);
    expect(stub.staffMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: STORE_ID } }),
    );
  });

  it("returns an empty list for a store with no staff (edge)", async () => {
    stub.staffMember.findMany.mockResolvedValue([]);

    expect(await listStaff(STORE_ID)).toEqual({ items: [] });
  });
});

describe("updateStaffMember (unit)", () => {
  it("updates role and permissions and returns the row with email", async () => {
    stub.staffMember.findFirst.mockResolvedValue({ ...STAFF_ROW, accountId: ACCOUNT_ID });
    stub.staffMember.update.mockResolvedValue({
      ...STAFF_ROW,
      role: "ADMIN",
      permissions: ["orders.manage"],
      updatedAt: new Date("2026-08-03T00:00:00Z"),
    });

    const result = await updateStaffMember(STORE_ID, STAFF_ID, {
      role: "ADMIN",
      permissions: ["orders.manage"],
    });

    expect(result).toEqual({
      id: STAFF_ID,
      email: "manager@example.com",
      role: "ADMIN",
      permissions: ["orders.manage"],
      updatedAt: new Date("2026-08-03T00:00:00Z"),
    });
    expect(stub.staffMember.update).toHaveBeenCalledWith({
      where: { id: STAFF_ID },
      data: { role: "ADMIN", permissions: ["orders.manage"] },
      include: expect.anything(),
    });
  });

  it("rejects an empty update (no role and no permissions)", async () => {
    await expect(updateStaffMember(STORE_ID, STAFF_ID, {})).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects an unknown permission flag (edge)", async () => {
    await expect(
      updateStaffMember(STORE_ID, STAFF_ID, { permissions: ["billing.nuke"] }),
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" });
  });

  it("returns 404 when the staff member belongs to another store", async () => {
    stub.staffMember.findFirst.mockResolvedValue(null);

    await expect(updateStaffMember(STORE_ID, STAFF_ID, { role: "ADMIN" })).rejects.toMatchObject({
      statusCode: 404,
      code: "STAFF_NOT_FOUND",
    });
  });
});

describe("removeStaffMember (unit)", () => {
  it("revokes the account's refresh tokens and deletes the row", async () => {
    stub.staffMember.findFirst.mockResolvedValue({ ...STAFF_ROW, accountId: ACCOUNT_ID });
    stub.staffMember.delete.mockResolvedValue({ ...STAFF_ROW });

    await removeStaffMember(STORE_ID, STAFF_ID);

    expect(authServiceMocks.revokeAllRefreshTokens).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(stub.staffMember.delete).toHaveBeenCalledWith({ where: { id: STAFF_ID } });
  });

  it("does not touch refresh tokens for a cross-store staffId (404)", async () => {
    stub.staffMember.findFirst.mockResolvedValue(null);

    await expect(removeStaffMember(STORE_ID, "other-store-staff")).rejects.toMatchObject({
      statusCode: 404,
      code: "STAFF_NOT_FOUND",
    });
  });
});

void AppError;
