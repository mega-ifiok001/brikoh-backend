import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { rateLimit } from "./rateLimit.js";

function makeReq(ip = "1.2.3.4") {
  return { ip } as never;
}
function makeRes() {
  return { set: vi.fn().mockReturnThis() } as unknown as Response;
}
function nextSpy() {
  return vi.fn();
}

describe("rateLimit", () => {
  it("enforces its own max independently of other limiter instances", () => {
    const limiterA = rateLimit({ windowMs: 60_000, max: 2 });
    const limiterB = rateLimit({ windowMs: 60_000, max: 100 });
    const next = nextSpy();

    limiterA(makeReq(), makeRes(), next); // 1 - ok
    limiterA(makeReq(), makeRes(), next); // 2 - ok
    const res3 = makeRes();
    limiterA(makeReq(), res3, next); // 3 - blocked

    expect(next).toHaveBeenCalledTimes(3);
    const blockedArg = next.mock.calls[2]?.[0];
    expect(blockedArg).toBeInstanceOf(Error);
    expect((blockedArg as { statusCode?: number }).statusCode).toBe(429);
    expect((blockedArg as { code?: string }).code).toBe("RATE_LIMITED");
    // The blocked response must carry Retry-After so clients can back off.
    expect(res3.set).toHaveBeenCalledWith("Retry-After", expect.any(String));

    // A different limiter instance keeps its own bucket — A's throttle must
    // not bleed into B (regression: buckets were previously keyed only by IP
    // and shared across every limiter instance).
    const nextB = nextSpy();
    limiterB(makeReq(), makeRes(), nextB);
    expect(nextB).toHaveBeenCalledTimes(1);
    expect(nextB.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("keys buckets per client IP", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1 });

    const next1 = nextSpy();
    limiter(makeReq("ip-1"), makeRes(), next1);
    const next2 = nextSpy();
    limiter(makeReq("ip-2"), makeRes(), next2);

    expect(next1.mock.calls[0]?.[0]).toBeUndefined();
    expect(next2.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("resets the bucket after the window elapses", async () => {
    const limiter = rateLimit({ windowMs: 50, max: 1 });

    const n1 = nextSpy();
    limiter(makeReq(), makeRes(), n1);
    const n2 = nextSpy();
    limiter(makeReq(), makeRes(), n2);
    expect((n2.mock.calls[0]?.[0] as { statusCode?: number }).statusCode).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 70));
    const n3 = nextSpy();
    limiter(makeReq(), makeRes(), n3);
    expect(n3.mock.calls[0]?.[0]).toBeUndefined();
  });
});
