import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "../src/lib/prisma.js";
import type { PrismaClient } from "../generated/prisma/client.js";

let prisma: PrismaClient;

const TENANT_SCOPED_TABLES = [
  "Owner",
  "StaffMember",
  "InviteToken",
  "Product",
  "StockLedgerEntry",
  "Customer",
  "Order",
  "OrderLineItem",
  "Invoice",
  "InvoiceLineItem",
  "Subscription",
  "WebhookEvent",
] as const;

/** Minimal valid Store profile — schema tests exercise fields other than the profile. */
const STORE_PROFILE = {
  businessType: "OTHER" as const,
  location: "Lagos, Nigeria",
  businessPhone: "+234 801 234 5678",
};

/** A store with its Main Branch, so order/ledger tests can name a branch. */
async function createStoreWithBranch(name: string, subdomain: string) {
  const store = await prisma.store.create({ data: { ...STORE_PROFILE, name, subdomain } });
  const mainBranch = await prisma.branch.create({
    data: { storeId: store.id, name: "Main Branch", address: "Lagos, Nigeria" },
  });
  await prisma.store.update({ where: { id: store.id }, data: { defaultBranchId: mainBranch.id } });
  return { store, mainBranch };
}

beforeEach(async () => {
  prisma = createPrismaClient(process.env.TEST_DATABASE_URL);
  // DELETE instead of TRUNCATE: TRUNCATE fsyncs every table file
  // (DataFileImmediateSync), which is very slow on rotational disks.
  // The append-only ledger trigger blocks DELETE, so it is disabled for
  // the duration of the wipe (TRUNCATE bypassed it silently before).
  await prisma.$executeRaw`
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    DELETE FROM "WebhookEvent"; DELETE FROM "OrderLineItem"; DELETE FROM "Order";
    DELETE FROM "InvoiceLineItem"; DELETE FROM "Invoice"; DELETE FROM "StockLedgerEntry";
    DELETE FROM "Product"; DELETE FROM "Customer"; DELETE FROM "StaffMember";
    DELETE FROM "InviteToken"; DELETE FROM "Owner"; DELETE FROM "Subscription";
    DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

afterEach(async () => {
  await prisma.$disconnect();
});

describe("required fields", () => {
  it("creates a Store with all required fields and default timestamps (happy path)", async () => {
    const store = await prisma.store.create({
      data: { name: "Ade's Store", subdomain: "ades-store", ...STORE_PROFILE },
    });

    expect(store.id).toBeTruthy();
    expect(store.name).toBe("Ade's Store");
    expect(store.createdAt).toBeInstanceOf(Date);
    expect(store.updatedAt).toBeInstanceOf(Date);
  });

  it("rejects a Store without a name (sad path)", async () => {
    await expect(
      prisma.store.create({ data: { subdomain: "no-name", ...STORE_PROFILE } }),
    ).rejects.toThrow();
  });

  it("rejects an Account without an email (sad path)", async () => {
    await expect(prisma.account.create({ data: { passwordHash: "hash" } })).rejects.toThrow();
  });

  it("rejects a Product without a price (sad path)", async () => {
    const store = await prisma.store.create({
      data: { ...STORE_PROFILE, name: "S", subdomain: "s1" },
    });

    await expect(
      prisma.product.create({ data: { storeId: store.id, name: "Widget" } }),
    ).rejects.toThrow();
  });

  it("accepts nullable optional fields (edge case)", async () => {
    const store = await prisma.store.create({
      data: { ...STORE_PROFILE, name: "S", subdomain: "s2" },
    });

    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Widget", price: 10, description: null, images: [] },
    });

    expect(product.description).toBeNull();
    expect(product.images).toEqual([]);
  });
});

describe("unique constraints", () => {
  it("allows the same externalEventId for different providers (edge case)", async () => {
    const store = await prisma.store.create({
      data: { ...STORE_PROFILE, name: "S", subdomain: "s3" },
    });

    await prisma.webhookEvent.create({
      data: { storeId: store.id, provider: "PAYSTACK", externalEventId: "evt-1", payload: {} },
    });
    const other = await prisma.webhookEvent.create({
      data: { storeId: store.id, provider: "STRIPE", externalEventId: "evt-1", payload: {} },
    });

    expect(other.externalEventId).toBe("evt-1");
  });

  it("rejects a duplicate Account email (sad path)", async () => {
    await prisma.account.create({ data: { email: "a@x.com", passwordHash: "hash" } });

    await expect(
      prisma.account.create({ data: { email: "a@x.com", passwordHash: "hash2" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects a duplicate Store subdomain (sad path)", async () => {
    await prisma.store.create({ data: { ...STORE_PROFILE, name: "S", subdomain: "dup" } });

    await expect(
      prisma.store.create({ data: { ...STORE_PROFILE, name: "S2", subdomain: "dup" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows multiple stores with null subdomain (SKIP stores, edge case)", async () => {
    await prisma.store.create({ data: { ...STORE_PROFILE, name: "S", subdomain: null } });
    const second = await prisma.store.create({
      data: { ...STORE_PROFILE, name: "S2", subdomain: null },
    });

    expect(second.subdomain).toBeNull();
    expect(await prisma.store.count()).toBe(2);
  });

  it("rejects a duplicate InviteToken token (sad path)", async () => {
    const store = await prisma.store.create({
      data: { ...STORE_PROFILE, name: "S", subdomain: "s4" },
    });

    await prisma.inviteToken.create({
      data: {
        token: "tok-1",
        email: "staff@x.com",
        storeId: store.id,
        role: "STAFF",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await expect(
      prisma.inviteToken.create({
        data: {
          token: "tok-1",
          email: "other@x.com",
          storeId: store.id,
          role: "ADMIN",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects a duplicate (provider, externalEventId) pair (sad path)", async () => {
    const store = await prisma.store.create({
      data: { ...STORE_PROFILE, name: "S", subdomain: "s5" },
    });

    await prisma.webhookEvent.create({
      data: { storeId: store.id, provider: "PAYSTACK", externalEventId: "evt-dup", payload: {} },
    });
    await expect(
      prisma.webhookEvent.create({
        data: { storeId: store.id, provider: "PAYSTACK", externalEventId: "evt-dup", payload: {} },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows only one Owner per Store (sad path)", async () => {
    const store = await prisma.store.create({
      data: { ...STORE_PROFILE, name: "S", subdomain: "s6" },
    });
    const accountA = await prisma.account.create({ data: { email: "a@x.com", passwordHash: "h" } });
    const accountB = await prisma.account.create({ data: { email: "b@x.com", passwordHash: "h" } });

    await prisma.owner.create({ data: { accountId: accountA.id, storeId: store.id } });
    await expect(
      prisma.owner.create({ data: { accountId: accountB.id, storeId: store.id } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("append-only StockLedgerEntry", () => {
  async function seedLedgerEntry(): Promise<{ productId: string; entryId: string }> {
    const { store, mainBranch } = await createStoreWithBranch("S", "s7");
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Widget", price: 10 },
    });
    const entry = await prisma.stockLedgerEntry.create({
      data: {
        storeId: store.id,
        branchId: mainBranch.id,
        productId: product.id,
        quantityChange: 5,
        reason: "RESTOCK",
      },
    });
    return { productId: product.id, entryId: entry.id };
  }

  it("accepts inserts (happy path)", async () => {
    const { entryId } = await seedLedgerEntry();
    const found = await prisma.stockLedgerEntry.findUnique({ where: { id: entryId } });

    expect(found?.quantityChange).toBe(5);
  });

  it("rejects updates (sad path)", async () => {
    const { entryId } = await seedLedgerEntry();

    await expect(
      prisma.stockLedgerEntry.update({
        where: { id: entryId },
        data: { quantityChange: 99 },
      }),
    ).rejects.toThrow();
  });

  it("rejects deletes (sad path)", async () => {
    const { entryId } = await seedLedgerEntry();

    await expect(prisma.stockLedgerEntry.delete({ where: { id: entryId } })).rejects.toThrow();
  });

  it("rejects a zero quantity change (edge case)", async () => {
    const { store, mainBranch } = await createStoreWithBranch("S", "s8");
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Widget", price: 10 },
    });

    await expect(
      prisma.stockLedgerEntry.create({
        data: {
          storeId: store.id,
          branchId: mainBranch.id,
          productId: product.id,
          quantityChange: 0,
          reason: "RESTOCK",
        },
      }),
    ).rejects.toThrow();
  });

  it("accepts negative changes for SALE (edge case)", async () => {
    const { store, mainBranch } = await createStoreWithBranch("S", "s9");
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Widget", price: 10 },
    });

    const entry = await prisma.stockLedgerEntry.create({
      data: {
        storeId: store.id,
        branchId: mainBranch.id,
        productId: product.id,
        quantityChange: -2,
        reason: "SALE",
      },
    });

    expect(entry.quantityChange).toBe(-2);
  });
});

describe("price captured at purchase time", () => {
  async function createOrderWithItem(
    price: number,
  ): Promise<{ lineItemId: string; productId: string }> {
    const { store, mainBranch } = await createStoreWithBranch("S", "s10");
    const customer = await prisma.customer.create({ data: { storeId: store.id, name: "Kunle" } });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Widget", price },
    });
    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        branchId: mainBranch.id,
        customerId: customer.id,
        orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
        total: price,
        lineItems: {
          create: [
            { storeId: store.id, productId: product.id, quantity: 1, unitPriceAtPurchase: price },
          ],
        },
      },
    });
    const lineItem = await prisma.orderLineItem.findFirstOrThrow({ where: { orderId: order.id } });
    return { lineItemId: lineItem.id, productId: product.id };
  }

  it("keeps the purchase-time price after the product price changes (happy path)", async () => {
    const { lineItemId, productId } = await createOrderWithItem(10);

    await prisma.product.update({ where: { id: productId }, data: { price: 25 } });

    const lineItem = await prisma.orderLineItem.findUniqueOrThrow({ where: { id: lineItemId } });
    expect(lineItem.unitPriceAtPurchase.toString()).toBe("10");
  });

  it("keeps distinct captured prices per line item (edge case)", async () => {
    const { store, mainBranch } = await createStoreWithBranch("S", "s11");
    const customer = await prisma.customer.create({ data: { storeId: store.id, name: "Kunle" } });
    const p1 = await prisma.product.create({ data: { storeId: store.id, name: "A", price: 10 } });
    const p2 = await prisma.product.create({ data: { storeId: store.id, name: "B", price: 20 } });

    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        branchId: mainBranch.id,
        customerId: customer.id,
        orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
        total: 30,
        lineItems: {
          create: [
            { storeId: store.id, productId: p1.id, quantity: 1, unitPriceAtPurchase: 10 },
            { storeId: store.id, productId: p2.id, quantity: 1, unitPriceAtPurchase: 20 },
          ],
        },
      },
    });

    await prisma.product.update({ where: { id: p1.id }, data: { price: 99 } });
    await prisma.product.update({ where: { id: p2.id }, data: { price: 1 } });

    const items = await prisma.orderLineItem.findMany({ where: { orderId: order.id } });
    expect(items.map((i) => i.unitPriceAtPurchase.toString()).sort()).toEqual(["10", "20"]);
  });

  it("rejects a negative purchase price (edge case)", async () => {
    const { store, mainBranch } = await createStoreWithBranch("S", "s12");
    const customer = await prisma.customer.create({ data: { storeId: store.id, name: "Kunle" } });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "A", price: 10 },
    });

    await expect(
      prisma.order.create({
        data: {
          storeId: store.id,
          branchId: mainBranch.id,
          customerId: customer.id,
          total: 10,
          lineItems: {
            create: [
              { storeId: store.id, productId: product.id, quantity: 1, unitPriceAtPurchase: -5 },
            ],
          },
        },
      }),
    ).rejects.toThrow();
  });
});

describe("order integrity", () => {
  async function seedStoreCustomerProduct(): Promise<{
    storeId: string;
    branchId: string;
    customerId: string;
    productId: string;
  }> {
    const { store, mainBranch } = await createStoreWithBranch("S", "s13");
    const customer = await prisma.customer.create({ data: { storeId: store.id, name: "Kunle" } });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Widget", price: 10 },
    });
    return {
      storeId: store.id,
      branchId: mainBranch.id,
      customerId: customer.id,
      productId: product.id,
    };
  }

  it("creates an order with line items in one transaction (happy path)", async () => {
    const { storeId, branchId, customerId, productId } = await seedStoreCustomerProduct();

    const order = await prisma.order.create({
      data: {
        storeId,
        branchId,
        customerId,
        orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
        total: 10,
        lineItems: {
          create: [{ storeId, productId, quantity: 1, unitPriceAtPurchase: 10 }],
        },
      },
    });

    const count = await prisma.orderLineItem.count({ where: { orderId: order.id } });
    expect(count).toBe(1);
  });

  it("rejects an order committed with zero line items (sad path)", async () => {
    const { storeId, branchId, customerId } = await seedStoreCustomerProduct();

    await expect(
      prisma.order.create({
        data: { storeId, branchId, customerId, orderNumber: "ORD-T0", total: 0 },
      }),
    ).rejects.toThrow();
  });

  it("rejects a zero-quantity line item (edge case)", async () => {
    const { storeId, branchId, customerId, productId } = await seedStoreCustomerProduct();

    await expect(
      prisma.order.create({
        data: {
          storeId,
          branchId,
          customerId,
          total: 0,
          lineItems: {
            create: [{ storeId, productId, quantity: 0, unitPriceAtPurchase: 10 }],
          },
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects deleting the last line item of an order (edge case)", async () => {
    const { storeId, branchId, customerId, productId } = await seedStoreCustomerProduct();

    const order = await prisma.order.create({
      data: {
        storeId,
        branchId,
        customerId,
        orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
        total: 10,
        lineItems: {
          create: [{ storeId, productId, quantity: 1, unitPriceAtPurchase: 10 }],
        },
      },
    });

    const lineItem = await prisma.orderLineItem.findFirstOrThrow({ where: { orderId: order.id } });
    await expect(prisma.orderLineItem.delete({ where: { id: lineItem.id } })).rejects.toThrow();
  });

  it("allows deleting one line item when another remains (edge case)", async () => {
    const { storeId, branchId, customerId, productId } = await seedStoreCustomerProduct();

    const order = await prisma.order.create({
      data: {
        storeId,
        branchId,
        customerId,
        orderNumber: `ORD-${crypto.randomUUID().slice(0, 8)}`,
        total: 20,
        lineItems: {
          create: [
            { storeId, productId, quantity: 1, unitPriceAtPurchase: 10 },
            { storeId, productId, quantity: 1, unitPriceAtPurchase: 10 },
          ],
        },
      },
    });

    const items = await prisma.orderLineItem.findMany({ where: { orderId: order.id } });
    await prisma.orderLineItem.delete({ where: { id: items[0]!.id } });

    const remaining = await prisma.orderLineItem.count({ where: { orderId: order.id } });
    expect(remaining).toBe(1);
  });
});

describe("tenant scoping", () => {
  // Prisma 7 keeps camelCase column names (e.g. storeId). The RULES.md
  // store_id wording refers to this tenant-scoping column.
  it("gives every tenant-scoped model an indexed storeId column", async () => {
    await Promise.all(
      TENANT_SCOPED_TABLES.map(async (table) => {
        const columns = await prisma.$queryRaw<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'storeId'
        `;
        expect(columns.length, `${table} must have a storeId column`).toBe(1);

        const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
          SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = ${table}
        `;
        const hasStoreIdIndex = indexes.some((i) => i.indexdef.includes("storeId"));
        expect(hasStoreIdIndex, `${table} must index storeId`).toBe(true);
      }),
    );
  }, 30_000);

  it("does not put storeId on Account or Store (the tenant root)", async () => {
    await Promise.all(
      ["Account", "Store"].map(async (table) => {
        const columns = await prisma.$queryRaw<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'storeId'
        `;
        expect(columns.length).toBe(0);
      }),
    );
  });
});
