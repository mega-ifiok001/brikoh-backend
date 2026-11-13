import { describe, expect, it } from "vitest";
import { randomSubdomain, slugify, subdomainCandidates } from "./slugs.js";
import { isReservedSubdomain } from "./reservedSubdomains.js";

describe("slugify", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(slugify("Ades Boutique")).toBe("ades-boutique");
  });

  it("collapses runs of non-letter characters into one hyphen", () => {
    expect(slugify("Ades' Boutique!!  & Co.")).toBe("ades-boutique-co");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("  Ades  ")).toBe("ades");
    expect(slugify("!Ades!")).toBe("ades");
  });

  it("truncates long names to leave room for a collision suffix", () => {
    const long = "b".repeat(80);
    expect(slugify(long)!.length).toBe(60);
  });

  it("returns null for names that cannot produce a 4-char letters-only slug", () => {
    expect(slugify("!!!")).toBeNull();
    expect(slugify("🐶")).toBeNull();
    expect(slugify("a")).toBeNull();
    expect(slugify("ab")).toBeNull();
    expect(slugify("abc")).toBeNull();
    expect(slugify("")).toBeNull();
    expect(slugify("123")).toBeNull();
  });

  it("strips digits and produces valid 4-63 char letters-only slugs", () => {
    expect(slugify("Store 42")).toBe("store");
    expect(slugify("Four Score")).toBe("four-score");
    expect(slugify("abcd")).toBe("abcd");
    expect(slugify("a-b")).toBeNull();
  });
});

describe("randomSubdomain", () => {
  it("produces a valid store- prefixed letters-only subdomain", () => {
    expect(randomSubdomain()).toMatch(/^store-[a-z]{8}$/);
  });
});

describe("isReservedSubdomain", () => {
  it("normalizes case and whitespace", () => {
    expect(isReservedSubdomain("Brikoh")).toBe(true);
    expect(isReservedSubdomain("  www  ")).toBe(true);
    expect(isReservedSubdomain("Www")).toBe(true);
  });

  it("does not reserve arbitrary store names", () => {
    expect(isReservedSubdomain("ades-boutique")).toBe(false);
    expect(isReservedSubdomain("ades-boutique-2")).toBe(false);
  });
});

describe("subdomainCandidates", () => {
  it("orders base slug, numeric suffixes, then random fallbacks", () => {
    const candidates = subdomainCandidates("Ades Boutique");
    expect(candidates[0]).toBe("ades-boutique");
    expect(candidates[1]).toBe("ades-boutique-2");
    expect(candidates[98]).toBe("ades-boutique-99");
    expect(candidates[99]).toMatch(/^store-[a-z]{8}$/);
  });

  it("always yields a valid candidate for unusable names", () => {
    const candidates = subdomainCandidates("!!!");
    expect(candidates[0]).toMatch(/^store-[a-z]{8}$/);
  });

  it("skips a reserved base and everything derived from it", () => {
    const candidates = subdomainCandidates("Brikoh");
    expect(candidates).not.toContain("brikoh");
    expect(candidates).not.toContain("brikoh-2");
    expect(candidates[0]).toMatch(/^store-[a-z]{8}$/);
  });

  it("never emits a candidate longer than 63 chars", () => {
    for (const candidate of subdomainCandidates("x".repeat(80))) {
      expect(candidate.length).toBeLessThanOrEqual(63);
      expect(candidate).toMatch(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/);
    }
  });

  it("stops suffixing once the length limit is reached", () => {
    const candidates = subdomainCandidates("y".repeat(60));
    expect(candidates[0]!.length).toBe(60);
    expect(candidates[1]).toBe(`${"y".repeat(60)}-2`);
    expect(candidates[1]!.length).toBe(62);
    expect(candidates[98]).toBe(`${"y".repeat(60)}-99`);
    expect(candidates[98]!.length).toBe(63);
  });
});
