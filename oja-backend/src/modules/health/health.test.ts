import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../../app.js";
import { getHealth } from "./service.js";

describe("health service (unit)", () => {
  it("returns a healthy status with the expected shape", () => {
    const result = getHealth();

    expect(result.status).toBe("ok");
    expect(result.uptime).toBeTypeOf("number");
    expect(result.timestamp).toBeTypeOf("string");
  });

  it("reports an uptime that is a finite, non-negative number", () => {
    const result = getHealth();

    expect(Number.isFinite(result.uptime)).toBe(true);
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it("returns a UTC ISO-8601 timestamp that is not in the future", () => {
    const result = getHealth();
    const before = Date.now();

    const parsed = Date.parse(result.timestamp);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeLessThanOrEqual(before);
    expect(result.timestamp.endsWith("Z")).toBe(true);
  });
});

describe("GET /api/public/health (integration)", () => {
  it("responds 200 with the health payload", async () => {
    const res = await request(app).get("/api/public/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      uptime: expect.any(Number) as number,
      timestamp: expect.any(String) as string,
    });
  });

  it("returns a well-formed UTC timestamp in the body", async () => {
    const res = await request(app).get("/api/public/health");

    expect(Number.isNaN(Date.parse(res.body.timestamp as string))).toBe(false);
    expect((res.body.timestamp as string).endsWith("Z")).toBe(true);
  });

  it("responds 404 with the uniform error shape for unknown routes", async () => {
    const res = await request(app).get("/api/public/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: expect.any(String) as string,
      },
    });
  });
});
