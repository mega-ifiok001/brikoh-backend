import { describe, expect, it } from "vitest";
import { createPrismaClient } from "../src/lib/prisma.js";

describe("prisma connection (integration)", () => {
  it("connects to the real test database", async () => {
    const prisma = createPrismaClient();
    try {
      const result = await prisma.$queryRaw<{ now: Date }[]>`SELECT NOW() as now`;
      expect(result[0]?.now).toBeInstanceOf(Date);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("fails fast with a clear error against an unreachable host (sad path)", async () => {
    const prisma = createPrismaClient("postgresql://nope:nope@localhost:59999/nope");
    try {
      await expect(prisma.$queryRaw`SELECT 1`).rejects.toThrow();
    } finally {
      await prisma.$disconnect();
    }
  });
});
