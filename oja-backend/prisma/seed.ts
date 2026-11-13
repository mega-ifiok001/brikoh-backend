import "dotenv/config";
import bcrypt from "bcrypt";
import { createPrismaClient } from "../src/lib/prisma.js";

/**
 * Seeds one realistic demo store. Idempotent: re-running upserts on unique
 * keys (subdomain, emails, tokens, provider+externalEventId) and only
 * creates products/orders when none exist for the store.
 */
// Fixed UUIDv7 identifiers for seed rows that other records reference by
// id (staff members, customers, the active subscription). Constant across
// seed runs so upserts stay idempotent.
const SEED_STAFF_ADMIN = "019FC8C4-4C03-7714-8044-149AEC5C39E4";
const SEED_STAFF_MANAGER = "019FC8C4-4C0F-7F41-8647-FBDE4188B097";
const SEED_STAFF_STAFF = "019FC8C4-4C10-72AC-8983-4679A4B2A2E3";
const SEED_CUSTOMER_KUNLE = "019FC8C4-4C10-74EA-AD7D-8D5AB1CAF9EB";
const SEED_CUSTOMER_CHIOMA = "019FC8C4-4C10-791C-AA1D-54E73AB329A3";
const SEED_SUBSCRIPTION_PRO = "019FC8C4-4C11-700A-BD46-5513250A7D3A";
const SEED_BRANCH_MAIN = "019FC8C4-4C12-7001-8000-000000000001";

/**
 * The dev-controlled storefront template catalog (same rows the
 * migration seeds, with fixed IDs so the upsert below is idempotent).
 * sortOrder IS the visibility ordering: templateCap slices this order
 * (STARTER 3, PRO 5, ENTERPRISE all).
 */
const SEED_TEMPLATES = [
  {
    id: "019FC8C4-5A01-7001-8001-000000000001",
    slug: "market",
    name: "Market Classic",
    description: "Simple single-column storefront",
  },
  {
    id: "019FC8C4-5A01-7001-8001-000000000002",
    slug: "boutique",
    name: "Boutique Chic",
    description: "Image-forward product cards",
  },
  {
    id: "019FC8C4-5A01-7001-8001-000000000003",
    slug: "minimal",
    name: "Minimal Clean",
    description: "Text-focused, whitespace-heavy layout",
  },
  {
    id: "019FC8C4-5A01-7001-8001-000000000004",
    slug: "urban",
    name: "Urban Edge",
    description: "Bold typography with dark accents",
  },
  {
    id: "019FC8C4-5A01-7001-8001-000000000005",
    slug: "fresh",
    name: "Fresh Grocer",
    description: "Produce-market layout",
  },
  {
    id: "019FC8C4-5A01-7001-8001-000000000006",
    slug: "luxe",
    name: "Luxe Noir",
    description: "Premium fashion presentation",
  },
  {
    id: "019FC8C4-5A01-7001-8001-000000000007",
    slug: "festive",
    name: "Festival Pop",
    description: "Seasonal, playful storefront",
  },
  {
    id: "019FC8C4-5A01-7001-8001-000000000008",
    slug: "glass",
    name: "Glass Showcase",
    description: "Gallery grid layout",
  },
] as const;

/**
 * Platform-staff seed (Phase 11 admin dashboard). Roles, permissions,
 * pricing rows, and the two SUPER_ADMIN founders are idempotently
 * upserted on their unique keys. The founders' TOTP secrets are fixed
 * valid base32 values so a support engineer can enroll their phone once
 * with the known secret.
 */
const SEED_ADMIN_FOUNDER = "019FC8C4-4D00-7701-88A0-000000000001";
const SEED_ADMIN_COFOUNDER = "019FC8C4-4D00-7702-88A0-000000000002";
const FOUNDER_TOTP_SECRET = "JBSWY3DPEHPK3PXP";

const ADMIN_PERMISSIONS = [
  { key: "stores:view", label: "view store search/detail/health" },
  { key: "billing:edit", label: "update plan pricing" },
  { key: "operations:run", label: "webhook reprocess + integrity diagnostics" },
  { key: "audit:view", label: "read the audit log (SUPER_ADMIN role only)" },
  { key: "admin:overview.view", label: "platform financial rollup (SUPER_ADMIN only)" },
  { key: "admin:merchants.view", label: "merchant (store + owner) list" },
  { key: "admin:stores.view", label: "store fleet view" },
  { key: "admin:orders.view", label: "cross-tenant order log" },
  { key: "admin:support.tickets.view", label: "view support tickets" },
  { key: "admin:support.tickets.manage", label: "manage support tickets" },
  { key: "admin:announcements.view", label: "view announcements" },
  { key: "admin:announcements.manage", label: "manage announcements" },
  { key: "admin:telemetry.view", label: "view platform telemetry" },
  { key: "admin:payments.awaiting-confirmation.view", label: "view pending bank-transfer claims" },
  { key: "admin:staff.view", label: "view platform staff sessions" },
] as const;

async function main(): Promise<void> {
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const now = Date.now();
  const day = 86_400_000;

  try {
    const store = await prisma.store.upsert({
      where: { subdomain: "demo" },
      update: {},
      create: {
        name: "Ade's Corner Store",
        subdomain: "demo",
        businessType: "RETAIL",
        location: "Lagos, Nigeria",
        currency: "NGN",
        businessPhone: "+2348000000000",
      },
    });

    // --- Storefront template catalog (dev-controlled) ----------------------
    for (const [index, template] of SEED_TEMPLATES.entries()) {
      await prisma.storeTemplate.upsert({
        where: { id: template.id },
        update: {},
        create: {
          id: template.id,
          slug: template.slug,
          name: template.name,
          description: template.description,
          sortOrder: index + 1,
          isActive: true,
        },
      });
    }
    // The demo store shows the PRO-tier set, so it uses the fifth template
    // (the last one PRO can see) — visible proof the catalog exists.
    await prisma.store.update({
      where: { id: store.id },
      data: { templateId: SEED_TEMPLATES[4].id },
    });

    // Every store has a "Main Branch" (its primary point, also the default
    // branch) — same shape the onboarding flow creates for real stores.
    const mainBranch = await prisma.branch.upsert({
      where: { id: SEED_BRANCH_MAIN },
      update: {},
      create: {
        id: SEED_BRANCH_MAIN,
        storeId: store.id,
        name: "Main Branch",
        address: store.location,
      },
    });
    await prisma.store.update({
      where: { id: store.id },
      data: { defaultBranchId: mainBranch.id },
    });

    const ownerAccount = await prisma.account.upsert({
      where: { email: "owner@demo-store.com" },
      update: {},
      create: {
        email: "owner@demo-store.com",
        passwordHash: bcrypt.hashSync("demo-password", 10),
      },
    });

    await prisma.owner.upsert({
      where: { storeId: store.id },
      update: {},
      create: { accountId: ownerAccount.id, storeId: store.id },
    });

    const adminAccount = await prisma.account.upsert({
      where: { email: "admin@demo-store.com" },
      update: {},
      create: {
        email: "admin@demo-store.com",
        passwordHash: bcrypt.hashSync("demo-password", 10),
      },
    });
    const managerAccount = await prisma.account.upsert({
      where: { email: "manager@demo-store.com" },
      update: {},
      create: {
        email: "manager@demo-store.com",
        passwordHash: bcrypt.hashSync("demo-password", 10),
      },
    });
    const staffAccount = await prisma.account.upsert({
      where: { email: "staff@demo-store.com" },
      update: {},
      create: {
        email: "staff@demo-store.com",
        passwordHash: bcrypt.hashSync("demo-password", 10),
      },
    });

    const inviteToken = await prisma.inviteToken.upsert({
      where: { token: "invite-staff-0001" },
      update: {},
      create: {
        token: "invite-staff-0001",
        email: "staff@demo-store.com",
        storeId: store.id,
        role: "STAFF",
        status: "ACCEPTED",
        expiresAt: new Date(now + 30 * day),
      },
    });

    const admin = await prisma.staffMember.upsert({
      where: { id: SEED_STAFF_ADMIN },
      update: {},
      create: {
        id: SEED_STAFF_ADMIN,
        accountId: adminAccount.id,
        storeId: store.id,
        role: "ADMIN",
        permissions: ["products.manage", "orders.manage", "staff.manage"],
      },
    });
    const manager = await prisma.staffMember.upsert({
      where: { id: SEED_STAFF_MANAGER },
      update: {},
      create: {
        id: SEED_STAFF_MANAGER,
        accountId: managerAccount.id,
        storeId: store.id,
        role: "MANAGER",
        permissions: ["products.manage", "orders.manage"],
      },
    });
    await prisma.staffMember.upsert({
      where: { id: SEED_STAFF_STAFF },
      update: {},
      create: {
        id: SEED_STAFF_STAFF,
        accountId: staffAccount.id,
        storeId: store.id,
        role: "STAFF",
        permissions: ["orders.manage"],
        inviteTokenId: inviteToken.id,
      },
    });

    const productSeed = [
      {
        name: "Ground Coffee 500g",
        price: 12.5,
        description: "Single-origin arabica",
        images: ["https://cdn.example.com/coffee.jpg"],
        quantity: 47,
      },
      {
        name: "Ceramic Mug",
        price: 8,
        description: "Handmade, 350ml",
        images: ["https://cdn.example.com/mug.jpg"],
        quantity: 19,
      },
      {
        name: "Tea Sampler Box",
        price: 15,
        description: "Six varieties",
        images: [],
        quantity: 15,
      },
      {
        name: "French Press 1L",
        price: 28,
        description: "Borosilicate glass",
        images: [],
        quantity: 0,
      },
      { name: "Honey 250g", price: 6.5, description: "Raw forest honey", images: [], quantity: 6 },
      {
        name: "Bread Knife",
        price: 18,
        description: "Serrated, walnut handle",
        images: [],
        quantity: 4,
      },
      {
        name: "Candle Set",
        price: 22,
        description: "Soy wax, three scents",
        images: [],
        quantity: 0,
      },
      {
        name: "Notebook A5",
        price: 9,
        description: "Recycled paper, linen cover",
        images: [],
        quantity: 0,
      },
      { name: "Tote Bag", price: 14, description: "Heavy canvas", images: [], quantity: 0 },
      {
        name: "Sourdough Starter Kit",
        price: 11,
        description: "Jar + starter culture",
        images: [],
        quantity: 0,
      },
    ] as const;

    const existingProducts = await prisma.product.count({ where: { storeId: store.id } });
    const products = new Map<string, { id: string; price: number }>();
    if (existingProducts === 0) {
      for (const seed of productSeed) {
        const product = await prisma.product.create({
          data: { storeId: store.id, ...seed },
        });
        products.set(product.name, { id: product.id, price: Number(product.price) });
      }
    } else {
      const rows = await prisma.product.findMany({ where: { storeId: store.id } });
      for (const row of rows) products.set(row.name, { id: row.id, price: Number(row.price) });
    }

    const ledgerSeed = [
      { product: "Ground Coffee 500g", quantityChange: 50, reason: "RESTOCK" as const },
      { product: "Ground Coffee 500g", quantityChange: -3, reason: "SALE" as const },
      { product: "Ceramic Mug", quantityChange: 20, reason: "RESTOCK" as const },
      { product: "Ceramic Mug", quantityChange: -1, reason: "MANUAL_ADJUSTMENT" as const },
      { product: "Tea Sampler Box", quantityChange: 15, reason: "RESTOCK" as const },
      { product: "Honey 250g", quantityChange: 10, reason: "RESTOCK" as const },
      { product: "Honey 250g", quantityChange: -4, reason: "SALE" as const },
      { product: "Bread Knife", quantityChange: 5, reason: "RESTOCK" as const },
      { product: "Bread Knife", quantityChange: -1, reason: "WRITE_OFF" as const },
    ] as const;

    if ((await prisma.stockLedgerEntry.count({ where: { storeId: store.id } })) === 0) {
      for (const entry of ledgerSeed) {
        const product = products.get(entry.product);
        if (product === undefined) continue;
        await prisma.stockLedgerEntry.create({
          data: {
            storeId: store.id,
            productId: product.id,
            quantityChange: entry.quantityChange,
            reason: entry.reason,
            performedByStaffId: entry.reason === "SALE" ? admin.id : manager.id,
          },
        });
      }
    }

    const kunle = await prisma.customer.upsert({
      where: { id: SEED_CUSTOMER_KUNLE },
      update: { name: "Kunle Adeyemi", phone: "+2348012345678", email: "kunle@example.com" },
      create: {
        id: SEED_CUSTOMER_KUNLE,
        storeId: store.id,
        name: "Kunle Adeyemi",
        phone: "+2348012345678",
        email: "kunle@example.com",
      },
    });
    const chioma = await prisma.customer.upsert({
      where: { id: SEED_CUSTOMER_CHIOMA },
      update: { name: "Chioma Okafor", phone: "+2348098765432", email: null },
      create: {
        id: SEED_CUSTOMER_CHIOMA,
        storeId: store.id,
        name: "Chioma Okafor",
        phone: "+2348098765432",
        email: null,
      },
    });

    if ((await prisma.order.count({ where: { storeId: store.id } })) === 0) {
      const coffee = products.get("Ground Coffee 500g");
      const mug = products.get("Ceramic Mug");
      const honey = products.get("Honey 250g");
      if (coffee !== undefined && mug !== undefined) {
        await prisma.order.create({
          data: {
            storeId: store.id,
            branchId: mainBranch.id,
            customerId: kunle.id,
            status: "PAID",
            orderNumber: "ORD-0001",
            total: 33,
            lineItems: {
              create: [
                { storeId: store.id, productId: coffee.id, quantity: 2, unitPriceAtPurchase: 12.5 },
                { storeId: store.id, productId: mug.id, quantity: 1, unitPriceAtPurchase: 8 },
              ],
            },
          },
        });
      }
      if (honey !== undefined && mug !== undefined) {
        await prisma.order.create({
          data: {
            storeId: store.id,
            branchId: mainBranch.id,
            customerId: chioma.id,
            status: "PENDING",
            orderNumber: "ORD-0002",
            total: 21,
            lineItems: {
              create: [
                { storeId: store.id, productId: honey.id, quantity: 2, unitPriceAtPurchase: 6.5 },
                { storeId: store.id, productId: mug.id, quantity: 1, unitPriceAtPurchase: 8 },
              ],
            },
          },
        });
      }
    }

    if ((await prisma.invoice.count({ where: { storeId: store.id } })) === 0) {
      const coffee = products.get("Ground Coffee 500g");
      const honey = products.get("Honey 250g");
      if (coffee !== undefined && honey !== undefined) {
        await prisma.invoice.create({
          data: {
            storeId: store.id,
            customerId: kunle.id,
            status: "ISSUED",
            total: 18,
            lineItems: {
              create: [
                { storeId: store.id, productId: coffee.id, quantity: 1, unitPriceAtIssue: 12.5 },
                { storeId: store.id, productId: honey.id, quantity: 1, unitPriceAtIssue: 5.5 },
              ],
            },
          },
        });
      }
    }

    await prisma.subscription.upsert({
      where: { id: SEED_SUBSCRIPTION_PRO },
      update: {},
      create: {
        id: SEED_SUBSCRIPTION_PRO,
        storeId: store.id,
        tier: "PRO",
        status: "ACTIVE",
        currentPeriodStart: new Date(now),
        currentPeriodEnd: new Date(now + 30 * day),
        staffCap: 10,
        locationCap: 2,
        productCap: 500,
        orderCap: 5000,
      },
    });
    // Point the store at its active subscription: cap enforcement (e.g.
    // the staff invite limit) reads Store.subscriptionId, not the row's
    // mere existence in the billing history.
    await prisma.store.update({
      where: { id: store.id },
      data: {
        subscriptionId: await prisma.subscription
          .findUnique({ where: { id: SEED_SUBSCRIPTION_PRO } })
          .then((row) => row?.id),
      },
    });

    await prisma.webhookEvent.upsert({
      where: {
        provider_externalEventId: { provider: "PAYSTACK", externalEventId: "evt-seed-0001" },
      },
      update: {},
      create: {
        storeId: store.id,
        provider: "PAYSTACK",
        externalEventId: "evt-seed-0001",
        payload: { event: "charge.success", amount: 3300 },
        status: "PROCESSED",
        processedAt: new Date(now - day),
      },
    });

    const totals = {
      products: await prisma.product.count({ where: { storeId: store.id } }),
      staff: await prisma.staffMember.count({ where: { storeId: store.id } }),
      ledger: await prisma.stockLedgerEntry.count({ where: { storeId: store.id } }),
      orders: await prisma.order.count({ where: { storeId: store.id } }),
      customers: await prisma.customer.count({ where: { storeId: store.id } }),
    };
    console.log(`Seeded store "${store.name}" (${store.subdomain}):`, totals);

    // --- Platform-staff RBAC (Phase 11) -----------------------------------
    const permissionRows = new Map<string, string>();
    for (const p of ADMIN_PERMISSIONS) {
      const row = await prisma.permission.upsert({
        where: { key: p.key },
        update: {},
        create: { key: p.key },
      });
      permissionRows.set(p.key, row.id);
    }

    const superRole = await prisma.role.upsert({
      where: { name: "SUPER_ADMIN" },
      update: {},
      create: { name: "SUPER_ADMIN" },
    });
    const supportRole = await prisma.role.upsert({
      where: { name: "SUPPORT_ADMIN" },
      update: {},
      create: { name: "SUPPORT_ADMIN" },
    });

    const bind = (roleId: string, key: string) =>
      prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId, permissionId: permissionRows.get(key) ?? "" },
        },
        update: {},
        create: { roleId, permissionId: permissionRows.get(key) ?? "" },
      });

    for (const key of [
      "stores:view",
      "billing:edit",
      "operations:run",
      "audit:view",
      "admin:overview.view",
      "admin:merchants.view",
      "admin:stores.view",
      "admin:orders.view",
      "admin:support.tickets.view",
      "admin:support.tickets.manage",
      "admin:announcements.view",
      "admin:announcements.manage",
      "admin:telemetry.view",
      "admin:payments.awaiting-confirmation.view",
      "admin:staff.view",
    ]) {
      await bind(superRole.id, key);
    }
    // Support admins get the non-financial cross-tenant read views only —
    // no billing, no operations, no audit access, and NOT the financial
    // overview rollup.
    for (const key of [
      "stores:view",
      "admin:merchants.view",
      "admin:stores.view",
      "admin:orders.view",
      "admin:payments.awaiting-confirmation.view",
      "admin:support.tickets.view",
      "admin:support.tickets.manage",
    ]) {
      await bind(supportRole.id, key);
    }

    await prisma.adminUser.upsert({
      where: { id: SEED_ADMIN_FOUNDER },
      update: { roleId: superRole.id },
      create: {
        id: SEED_ADMIN_FOUNDER,
        email: "admin@brikoh.dev",
        passwordHash: bcrypt.hashSync("admin-password-1", 10),
        twoFactorSecret: FOUNDER_TOTP_SECRET,
        roleId: superRole.id,
      },
    });
    await prisma.adminUser.upsert({
      where: { id: SEED_ADMIN_COFOUNDER },
      update: { roleId: superRole.id },
      create: {
        id: SEED_ADMIN_COFOUNDER,
        email: "founder@brikoh.dev",
        passwordHash: bcrypt.hashSync("founder-password-2", 10),
        twoFactorSecret: FOUNDER_TOTP_SECRET,
        roleId: superRole.id,
      },
    });

    // --- Admin-mutable plan pricing (single source of truth for MRR) ------
    // Placeholder amounts while pricing is under discussion; the admin
    // dashboard changes them at runtime via PUT /api/admin/billing/pricing.
    const priceSeed = [
      { plan: "STARTER" as const, monthlyPrice: null },
      { plan: "PRO" as const, monthlyPrice: 4900 },
      { plan: "ENTERPRISE" as const, monthlyPrice: 19000 },
    ];
    for (const p of priceSeed) {
      await prisma.subscriptionPlanSetting.upsert({
        where: { plan: p.plan },
        update: { monthlyPrice: p.monthlyPrice },
        create: { plan: p.plan, monthlyPrice: p.monthlyPrice },
      });
    }
    console.log("Seeded platform staff RBAC:", {
      roles: [superRole.name, supportRole.name],
      permissions: ADMIN_PERMISSIONS.length,
      admins: ["admin@brikoh.dev", "founder@brikoh.dev"],
      pricing: priceSeed.map((p) => `${p.plan}=${p.monthlyPrice ?? "free"}`),
    });
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Seed failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
