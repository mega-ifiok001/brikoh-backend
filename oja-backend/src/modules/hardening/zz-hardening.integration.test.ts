import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../../app.js";
import { env } from "../../../src/config/env.js";

/**
 * HTTP hardening regression suite (helmet, CORS, rate limiting).
 *
 * This file is named zz-* so it sorts LAST: its rate-limit test exhausts
 * the in-memory bucket for the accept-invite endpoint (301 requests from
 * the same client IP), and a later suite could not rely on that bucket
 * being empty within the 60s window.
 */

const frontendOrigin = new URL(env.FRONTEND_URL);

/** A realistic merchant storefront subdomain under FRONTEND_URL's apex. */
function merchantSubdomainOrigin(): string {
  const labels = frontendOrigin.hostname.split(".");
  const apex = labels.length > 2 ? labels.slice(-2).join(".") : frontendOrigin.hostname;
  return `https://a-merchant-store.${apex}`;
}

describe("HTTP hardening (helmet)", () => {
  it("sends the non-CSP helmet protections on every response", async () => {
    const res = await request(app).get("/api/public/health");

    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["referrer-policy"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
    // CSP is deliberately disabled (JSON-only API — see the helmet() call
    // in app.ts). A future reviewer must not re-enable it without a
    // serving-HTML reason, so this regression pins it off.
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });
});

describe("HTTP hardening (CORS, derived from FRONTEND_URL)", () => {
  it("reflects the origin for the exact FRONTEND_URL (dashboard)", async () => {
    const res = await request(app).get("/api/public/health").set("Origin", frontendOrigin.origin);

    expect(res.headers["access-control-allow-origin"]).toBe(frontendOrigin.origin);
  });

  it("allows checkout requests from a realistic merchant storefront subdomain", async () => {
    const origin = merchantSubdomainOrigin();

    // Unknown subdomain → the checkout route 404s, but CORS runs before
    // routing: the headers must be present on the response either way.
    const res = await request(app)
      .post("/api/public/checkout/no-such-store")
      .set("Origin", origin)
      .send({ customer: { name: "Ade", email: "a@b.com", phone: "08012345678" }, items: [] });

    expect(res.status).toBe(404);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
  });

  it("rejects an origin outside the allowed pattern (no ACAO header)", async () => {
    const res = await request(app)
      .get("/api/public/health")
      .set("Origin", "https://evil.example.net");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows localhost dev origins", async () => {
    const res = await request(app).get("/api/public/health").set("Origin", "http://localhost:5173");

    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("never emits a wildcard Access-Control-Allow-Origin", async () => {
    const res = await request(app)
      .get("/api/public/health")
      .set("Origin", merchantSubdomainOrigin());

    expect(res.headers["access-control-allow-origin"]).toBeDefined();
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });
});

describe("rate limiting — accept-invite (credential endpoint)", () => {
  it("returns 429 once the per-window budget is exhausted", async () => {
    // The invite token is a credential; the mount must be rate-limited.
    // Budget is 300/min per IP: 300 requests pass, the 301st is rejected.
    let lastStatus = 0;
    for (let i = 0; i <= 300; i += 1) {
      const res = await request(app)
        .post("/api/public/auth/accept-invite")
        .send({ token: "definitely-not-a-real-token" });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
