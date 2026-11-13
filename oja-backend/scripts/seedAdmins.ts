import "dotenv/config";
import bcrypt from "bcrypt";
import { createPrismaClient } from "../src/lib/prisma.js";
import { generateTotpSecret, buildTotpOtpauthUrl } from "../src/modules/admin/totp.js";

const prisma = createPrismaClient();

// CHANGE THESE PASSWORDS before running (or immediately after). They are
// hardcoded only so you don't have to pass env vars — rotate them later
// via the admin dashboard / a direct update.
const ADMINS = [
  { slug: "MEGA", email: "mega@brikoh.com", password: "SuperMegaPassword" },
  { slug: "ANIETIE", email: "anietie@brikoh.com", password: "SuperAnniPassword" },
] as const;

// The platform permissions every SUPER_ADMIN needs. Seeded here so the
// script is self-sufficient (no need to run the main seed first). Keep in sync
// with prisma/seed.ts's ADMIN_PERMISSIONS.
const ADMIN_PERMISSIONS = [
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
] as const;

async function ensureSuperAdminRole() {
  const role = await prisma.role.upsert({
    where: { name: "SUPER_ADMIN" },
    update: {},
    create: { name: "SUPER_ADMIN" },
  });
  // Ensure the permission rows exist, then bind all of them to SUPER_ADMIN so
  // the role is effectively "God/root". Makes the script runnable on its own.
  const permissionIds = new Map<string, string>();
  for (const key of ADMIN_PERMISSIONS) {
    const row = await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key },
    });
    permissionIds.set(key, row.id);
  }
  for (const key of ADMIN_PERMISSIONS) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permissionIds.get(key) ?? "" },
      },
      update: {},
      create: { roleId: role.id, permissionId: permissionIds.get(key) ?? "" },
    });
  }
  return role;
}

async function main() {
  const role = await ensureSuperAdminRole();
  for (const admin of ADMINS) {
    const secret = generateTotpSecret();
    const otpauthUrl = buildTotpOtpauthUrl(secret, admin.email);

    await prisma.adminUser.upsert({
      where: { email: admin.email },
      update: {
        passwordHash: bcrypt.hashSync(admin.password, 10),
        twoFactorSecret: secret,
        roleId: role.id,
        isActive: true,
      },
      create: {
        email: admin.email,
        passwordHash: bcrypt.hashSync(admin.password, 10),
        twoFactorSecret: secret,
        roleId: role.id,
        isActive: true,
      },
    });

    console.log("------------------------------------------------------------");
    console.log(`Admin       : ${admin.email}`);
    console.log(`Role        : ${role.name} (God/root)`);
    console.log(`TOTP secret : ${secret}`);
    console.log(`otpauth URL : ${otpauthUrl}`);
    console.log("Add to Google Authenticator via the secret above or the QR of the URL.");
    console.log("------------------------------------------------------------");
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
