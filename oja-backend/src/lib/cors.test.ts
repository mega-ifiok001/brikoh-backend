import { describe, expect, it } from "vitest";
import { env } from "../config/env.js";
import { isAllowedCorsOrigin } from "./cors.js";

describe("isAllowedCorsOrigin", () => {
  it("allows requests without an Origin header (same-origin / non-browser clients)", () => {
    expect(isAllowedCorsOrigin(undefined)).toBe(true);
  });

  it("rejects malformed origins", () => {
    expect(isAllowedCorsOrigin("not-a-url")).toBe(false);
    expect(isAllowedCorsOrigin("")).toBe(false);
  });

  it("allows any localhost dev port (any port, any address)", () => {
    expect(isAllowedCorsOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedCorsOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedCorsOrigin("http://localhost:8080")).toBe(true);
    expect(isAllowedCorsOrigin("http://localhost:9999")).toBe(true);
    expect(isAllowedCorsOrigin("http://localhost:5500")).toBe(true);
    expect(isAllowedCorsOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedCorsOrigin("http://127.0.0.1:8080")).toBe(true);
    expect(isAllowedCorsOrigin("http://[::1]:3000")).toBe(true);
    expect(isAllowedCorsOrigin("https://localhost:5173")).toBe(false);
    expect(isAllowedCorsOrigin("http://localhost:5173:extra")).toBe(false);
  });

  it("allows the exact FRONTEND_URL origin", () => {
    expect(isAllowedCorsOrigin(env.FRONTEND_URL)).toBe(true);
  });

  it("allows subdomains of the FRONTEND_URL apex", () => {
    const { hostname } = new URL(env.FRONTEND_URL);
    const labels = hostname.split(".");
    const apex = labels.length > 2 ? labels.slice(-2).join(".") : hostname;

    expect(isAllowedCorsOrigin(`https://some-store.${apex}`)).toBe(true);
    expect(isAllowedCorsOrigin(`https://nested.some-store.${apex}`)).toBe(true);
  });

  it("allows every origin listed in CORS_EXTRA_ORIGINS", () => {
    for (const origin of env.CORS_EXTRA_ORIGINS) {
      expect(isAllowedCorsOrigin(origin)).toBe(true);
    }
  });

  it("allows sibling subdomains of each CORS_EXTRA_ORIGINS apex (rotating preview hosts)", () => {
    for (const origin of env.CORS_EXTRA_ORIGINS) {
      const { hostname } = new URL(origin);
      const labels = hostname.split(".");
      const apex = labels.length > 2 ? labels.slice(-2).join(".") : hostname;
      expect(isAllowedCorsOrigin(`https://fresh-preview-id.${apex}`)).toBe(true);
      expect(isAllowedCorsOrigin(`https://nested.fresh-preview-id.${apex}`)).toBe(true);
    }
  });

  it("rejects the bare apex itself — only subdomains are allowed", () => {
    const { hostname: frontendHost } = new URL(env.FRONTEND_URL);
    const frontendLabels = frontendHost.split(".");
    const frontendApex =
      frontendLabels.length > 2 ? frontendLabels.slice(-2).join(".") : frontendHost;

    if (frontendApex !== frontendHost) {
      expect(isAllowedCorsOrigin(`https://${frontendApex}`)).toBe(false);
    }

    for (const origin of env.CORS_EXTRA_ORIGINS) {
      const extraHost = new URL(origin).hostname;
      const extraLabels = extraHost.split(".");
      const extraApex = extraLabels.length > 2 ? extraLabels.slice(-2).join(".") : extraHost;
      if (extraApex !== extraHost && extraApex !== frontendApex) {
        expect(isAllowedCorsOrigin(`https://${extraApex}`)).toBe(false);
      }
    }
  });

  it("rejects origins outside every configured apex", () => {
    const { hostname } = new URL(env.FRONTEND_URL);
    const labels = hostname.split(".");
    const apex = labels.length > 2 ? labels.slice(-2).join(".") : hostname;

    expect(isAllowedCorsOrigin(`https://unrelated.${apex}.invalid`)).toBe(false);
    expect(isAllowedCorsOrigin(`https://evil.unrelated-${apex}.invalid`)).toBe(false);
  });
});
