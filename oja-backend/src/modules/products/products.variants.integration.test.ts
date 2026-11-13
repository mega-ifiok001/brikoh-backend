import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../../app.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { signAccessToken } from "../../lib/tokens.js";

const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);

async function createTenantWithOwner() {
  const account = await prisma.account.create({
    data: {
      email: `owner-${crypto.randomUUID()}@example.com`,
      passwordHash: bcrypt.hashSync("password-123", 4),
    },
  });
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
  const token = signAccessToken({ sub: account.id, storeId: store.id, role: "OWNER" });
  return { store, mainBranch, token };
}

beforeEach(async () => {
  await prisma.$executeRaw`
    ALTER TABLE "StockLedgerEntry" DISABLE TRIGGER stock_ledger_append_only;
    ALTER TABLE "StoreActivityLog" DISABLE TRIGGER store_activity_log_append_only;
    DELETE FROM "OrderLineItem"; DELETE FROM "Order";
    DELETE FROM "ProductVariantOptionValue"; DELETE FROM "ProductOptionValue"; DELETE FROM "ProductOption";
    DELETE FROM "StockLedgerEntry"; DELETE FROM "Product"; DELETE FROM "Customer";
    DELETE FROM "BranchStock"; DELETE FROM "Branch";
    DELETE FROM "StaffMember"; DELETE FROM "Owner"; DELETE FROM "StoreActivityLog";
    DELETE FROM "Store"; DELETE FROM "Account";
    ALTER TABLE "StoreActivityLog" ENABLE TRIGGER store_activity_log_append_only;
    ALTER TABLE "StockLedgerEntry" ENABLE TRIGGER stock_ledger_append_only;
  `;
});

describe("product options & variants (integration)", () => {
  it("creates a product with an option grid and derives variant names + links", async () => {
    const { token } = await createTenantWithOwner();

    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "T-Shirt",
        price: 20,
        options: [
          { name: "Colour", values: ["Red", "Blue"] },
          { name: "Size", values: ["S", "M"] },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.options).toHaveLength(2);
    expect(res.body.options[0]).toMatchObject({ name: "Colour" });
    expect(res.body.options[0].values.map((v: { value: string }) => v.value)).toEqual([
      "Red",
      "Blue",
    ]);
    expect(res.body.variants).toHaveLength(4);
    const names = res.body.variants.map((v: { name: string }) => v.name).sort();
    expect(names).toEqual(["Blue / M", "Blue / S", "Red / M", "Red / S"]);
    expect(res.body.variants[0].options).toHaveLength(2);

    // Each generated variant got its default-branch stock row.
    const variantIds = res.body.variants.map((v: { id: string }) => v.id);
    const stockRows = await prisma.branchStock.count({ where: { variantId: { in: variantIds } } });
    expect(stockRows).toBe(4);
  });

  it("rejects more than two options (400)", async () => {
    const { token } = await createTenantWithOwner();
    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "X",
        price: 5,
        options: [
          { name: "A", values: ["1"] },
          { name: "B", values: ["2"] },
          { name: "C", values: ["3"] },
        ],
      });
    expect(res.status).toBe(400);
  });

  it("rejects a grid larger than 50 variants (409)", async () => {
    const { token } = await createTenantWithOwner();
    const res = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Big",
        price: 5,
        options: [
          { name: "Colour", values: ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"] },
          { name: "Size", values: ["S1", "S2", "S3", "S4", "S5", "S6", "S7"] },
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VARIANT_LIMIT_REACHED");
  });

  it("preserves existing variants (price/stock) when a value is added", async () => {
    const { store, token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Tee", price: 20, options: [{ name: "Colour", values: ["Red", "Blue"] }] });
    const redId = created.body.variants.find((v: { name: string }) => v.name === "Red").id;

    // Re-price + restock the red variant.
    await request(app)
      .patch(`/api/dashboard/products/${created.body.id}/variants/${redId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sellingPrice: "18.00" })
      .expect(200);
    await prisma.branchStock.updateMany({
      where: { storeId: store.id, variantId: redId },
      data: { quantity: 7 },
    });

    // Add a new colour → grid grows, red keeps its price/stock.
    const res = await request(app)
      .put(`/api/dashboard/products/${created.body.id}/options`)
      .set("Authorization", `Bearer ${token}`)
      .send({ options: [{ name: "Colour", values: ["Red", "Blue", "Green"] }] });
    expect(res.status).toBe(200);
    expect(res.body.variants).toHaveLength(3);

    const red = res.body.variants.find((v: { id: string }) => v.id === redId);
    expect(red.sellingPrice).toBe("18");
    const stock = await prisma.branchStock.findFirst({
      where: { storeId: store.id, variantId: redId },
    });
    expect(stock?.quantity).toBe(7);
  });

  it("archives variants whose value is removed, and hides them from the storefront", async () => {
    const { store, token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Tee", price: 20, options: [{ name: "Colour", values: ["Red", "Blue"] }] });
    const blueId = created.body.variants.find((v: { name: string }) => v.name === "Blue").id;

    const res = await request(app)
      .put(`/api/dashboard/products/${created.body.id}/options`)
      .set("Authorization", `Bearer ${token}`)
      .send({ options: [{ name: "Colour", values: ["Red"] }] });
    expect(res.status).toBe(200);
    expect(res.body.variants).toHaveLength(2); // dashboard shows archived too
    const blue = res.body.variants.find((v: { id: string }) => v.id === blueId);
    expect(blue.archivedAt).not.toBeNull();

    // Public catalog returns only the active (Red) variant.
    await prisma.product.update({
      where: { id: created.body.id },
      data: { status: "PUBLISHED" },
    });
    const pub = await request(app).get(`/api/public/storefront/${store.subdomain}/products`);
    expect(pub.status).toBe(200);
    const item = pub.body.items.find((p: { id: string }) => p.id === created.body.id);
    expect(item.variants).toHaveLength(1);
    expect(item.variants[0].name).toBe("Red");
  });

  it("archives + restores a variant via the endpoints", async () => {
    const { token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Tee", price: 20, options: [{ name: "Size", values: ["S", "M"] }] });
    const id = created.body.variants[0].id;

    const archived = await request(app)
      .post(`/api/dashboard/products/${created.body.id}/variants/${id}/archive`)
      .set("Authorization", `Bearer ${token}`);
    expect(archived.status).toBe(200);
    expect(archived.body.variants.find((v: { id: string }) => v.id === id).archivedAt).not.toBeNull();

    const restored = await request(app)
      .post(`/api/dashboard/products/${created.body.id}/variants/${id}/restore`)
      .set("Authorization", `Bearer ${token}`);
    expect(restored.status).toBe(200);
    expect(
      restored.body.variants.find((v: { id: string }) => v.id === id).archivedAt,
    ).toBeNull();
  });

  it("404s a variant that belongs to another product", async () => {
    const { token } = await createTenantWithOwner();
    const a = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "A", price: 5, options: [{ name: "Size", values: ["S"] }] });
    const b = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "B", price: 5, options: [{ name: "Size", values: ["M"] }] });

    const res = await request(app)
      .patch(`/api/dashboard/products/${a.body.id}/variants/${b.body.variants[0].id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sellingPrice: "1.00" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("VARIANT_NOT_FOUND");
  });

  it("can remove all options, archiving every variant (revert to variant-less)", async () => {
    const { token } = await createTenantWithOwner();
    const created = await request(app)
      .post("/api/dashboard/products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Tee", price: 20, options: [{ name: "Size", values: ["S", "M"] }] });

    const res = await request(app)
      .put(`/api/dashboard/products/${created.body.id}/options`)
      .set("Authorization", `Bearer ${token}`)
      .send({ options: [] });
    expect(res.status).toBe(200);
    expect(res.body.options).toEqual([]);
    expect(res.body.variants.every((v: { archivedAt: string | null }) => v.archivedAt !== null)).toBe(
      true,
    );
  });
});
