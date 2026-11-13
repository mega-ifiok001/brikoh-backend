import { describe, expect, it, vi } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import {
  computeDiscountAmount,
  isDiscountAvailable,
  resolveExplicitDiscount,
  resolveGroupDiscount,
} from "./apply.js";

const D = (v: string | number) => new Prisma.Decimal(v);

type AvailableRow = {
  id: string;
  name: string;
  type: "PERCENTAGE" | "FIXED";
  value: Prisma.Decimal;
  isActive: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
};

function activeRow(overrides: Partial<AvailableRow> = {}): AvailableRow {
  return {
    id: "discount-1",
    name: "Ten percent",
    type: "PERCENTAGE",
    value: D("10"),
    isActive: true,
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

type Mock = ReturnType<typeof vi.fn>;

type DiscountQueryClient = Parameters<typeof resolveExplicitDiscount>[0];

function discountClient() {
  return {
    discount: { findFirst: vi.fn(), findUnique: vi.fn() },
    customer: { findFirst: vi.fn() },
  };
}

type Client = ReturnType<typeof discountClient>;
const asClient = (client: Client): DiscountQueryClient => client as unknown as DiscountQueryClient;

function mockFindFirst(client: Client): Mock {
  return client.discount.findFirst as Mock;
}

function mockFindUnique(client: Client): Mock {
  return client.discount.findUnique as Mock;
}

function mockCustomerFindFirst(client: Client): Mock {
  return client.customer.findFirst as Mock;
}

describe("isDiscountAvailable", () => {
  const now = new Date("2026-08-15T12:00:00.000Z");

  it("is available when active and inside the window", () => {
    expect(
      isDiscountAvailable(
        {
          ...activeRow(),
          startsAt: new Date("2026-08-01T00:00:00.000Z"),
          endsAt: new Date("2026-08-31T23:59:59.000Z"),
        },
        now,
      ),
    ).toBe(true);
  });

  it("is unavailable when inactive, not yet started, or expired", () => {
    expect(isDiscountAvailable(activeRow({ isActive: false }), now)).toBe(false);
    expect(
      isDiscountAvailable(activeRow({ startsAt: new Date("2026-08-16T00:00:00.000Z") }), now),
    ).toBe(false);
    expect(
      isDiscountAvailable(activeRow({ endsAt: new Date("2026-08-15T12:00:00.000Z") }), now),
    ).toBe(false);
  });
});

describe("computeDiscountAmount", () => {
  it("computes PERCENTAGE with 2-dp half-up rounding", () => {
    expect(
      computeDiscountAmount({ id: "d", name: "x", type: "PERCENTAGE", value: D("10") }, D("19.98")),
    ).toEqual(D("2.00"));
    expect(
      computeDiscountAmount(
        { id: "d", name: "x", type: "PERCENTAGE", value: D("33.333") },
        D("3.00"),
      ),
    ).toEqual(D("1.00"));
  });

  it("caps PERCENTAGE so the total never goes below zero", () => {
    expect(
      computeDiscountAmount(
        { id: "d", name: "x", type: "PERCENTAGE", value: D("100") },
        D("19.98"),
      ),
    ).toEqual(D("19.98"));
  });

  it("applies FIXED as-is and caps it at the line total", () => {
    expect(
      computeDiscountAmount({ id: "d", name: "x", type: "FIXED", value: D("5.00") }, D("19.98")),
    ).toEqual(D("5.00"));
    expect(
      computeDiscountAmount({ id: "d", name: "x", type: "FIXED", value: D("25.00") }, D("19.98")),
    ).toEqual(D("19.98"));
  });
});

describe("resolveExplicitDiscount", () => {
  const now = new Date("2026-08-15T12:00:00.000Z");

  it("returns null when neither id nor code is given", async () => {
    await expect(
      resolveExplicitDiscount(asClient(discountClient()), "store-1", {}, now),
    ).resolves.toBeNull();
  });

  it("resolves by code (case-insensitive, uppercased) and validates availability", async () => {
    const client = discountClient();
    mockFindFirst(client).mockResolvedValue(activeRow());

    const result = await resolveExplicitDiscount(
      asClient(client),
      "store-1",
      { discountCode: "grand-opening" },
      now,
    );

    expect(mockFindFirst(client)).toHaveBeenCalledWith({
      where: { storeId: "store-1", code: "GRAND-OPENING" },
    });
    expect(result).toEqual({
      id: "discount-1",
      name: "Ten percent",
      type: "PERCENTAGE",
      value: D("10"),
    });
  });

  it("throws 404 DISCOUNT_NOT_FOUND for an unknown code", async () => {
    const client = discountClient();
    mockFindFirst(client).mockResolvedValue(null);

    await expect(
      resolveExplicitDiscount(asClient(client), "store-1", { discountCode: "NOPE" }, now),
    ).rejects.toMatchObject({ code: "DISCOUNT_NOT_FOUND", statusCode: 404 });
  });

  it("throws 400 DISCOUNT_UNAVAILABLE for an inactive or windowed-out discount", async () => {
    const client = discountClient();
    mockFindFirst(client).mockResolvedValue(activeRow({ isActive: false }));

    await expect(
      resolveExplicitDiscount(asClient(client), "store-1", { discountCode: "LAPSED" }, now),
    ).rejects.toMatchObject({ code: "DISCOUNT_UNAVAILABLE", statusCode: 400 });
  });

  it("rejects giving both id and code (400 VALIDATION_ERROR)", async () => {
    await expect(
      resolveExplicitDiscount(asClient(discountClient()), "store-1", {
        discountId: "a",
        discountCode: "B",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
  });
});

describe("resolveGroupDiscount", () => {
  const now = new Date("2026-08-15T12:00:00.000Z");

  it("returns the customer's group discount when it is available", async () => {
    const client = discountClient();
    mockCustomerFindFirst(client).mockResolvedValue({
      group: { discount: { id: "discount-1" } },
    });
    mockFindUnique(client).mockResolvedValue(
      activeRow({ id: "discount-1", type: "FIXED", value: D("3.00") }),
    );

    const result = await resolveGroupDiscount(asClient(client), "store-1", "cust-1", now);

    expect(result).toEqual({
      id: "discount-1",
      name: "Ten percent",
      type: "FIXED",
      value: D("3.00"),
    });
  });

  it("returns null when the customer has no group or the group has no discount", async () => {
    const client = discountClient();
    mockCustomerFindFirst(client).mockResolvedValueOnce({ group: null });
    await expect(
      resolveGroupDiscount(asClient(client), "store-1", "cust-1", now),
    ).resolves.toBeNull();

    mockCustomerFindFirst(client).mockResolvedValueOnce({ group: { discount: null } });
    await expect(
      resolveGroupDiscount(asClient(client), "store-1", "cust-1", now),
    ).resolves.toBeNull();
  });

  it("silently returns null for an unavailable group discount (never an error)", async () => {
    const client = discountClient();
    mockCustomerFindFirst(client).mockResolvedValue({ group: { discount: { id: "discount-1" } } });
    mockFindUnique(client).mockResolvedValue(activeRow({ isActive: false }));

    await expect(
      resolveGroupDiscount(asClient(client), "store-1", "cust-1", now),
    ).resolves.toBeNull();
  });
});
