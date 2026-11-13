/**
 * Slug helpers. Kept deliberately small — slugify() is the only rule,
 * and it must mirror the subdomain contract exactly (see
 * docs/api-contracts/dashboard-onboarding.md): lowercase letters and
 * hyphens only (no digits), 4-63 chars.
 */

import { isReservedSubdomain } from "./reservedSubdomains.js";

/** The subdomain's length bounds. */
export const MAX_SUBDOMAIN_LENGTH = 63;

/** Shortest allowed subdomain (e.g. a 4-letter store name). */
export const MIN_SUBDOMAIN_LENGTH = 4;

/** How much room the collision suffix ("-2" .. "-99") needs. */
const SUFFIX_ROOM = 3;

/** Max length of the base slug so any numeric suffix still fits. */
const MAX_BASE_LENGTH = MAX_SUBDOMAIN_LENGTH - SUFFIX_ROOM;

/**
 * Derives a storefront subdomain candidate from a store name. Returns
 * null when the name cannot produce a valid slug (empty after
 * sanitization, or shorter than MIN_SUBDOMAIN_LENGTH).
 *
 * Rules: lowercase; any run of non-letter characters (spaces, digits,
 * punctuation) becomes a single hyphen; leading/trailing hyphens are
 * stripped; the result is truncated to 60 chars (leaving room for a
 * collision suffix).
 */
export function slugify(name: string): string | null {
  const candidate = name
    .toLowerCase()
    .replace(/[^a-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BASE_LENGTH)
    .replace(/-+$/g, "");
  if (!/^[a-z][a-z-]{2,61}[a-z]$/.test(candidate)) {
    return null;
  }
  return candidate;
}

/** Random letters-only fallback used when the name yields no usable slug. */
export function randomSubdomain(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let suffix = "";
  for (let i = 0; i < 8; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `store-${suffix}`;
}

/**
 * Builds the ordered list of subdomain candidates for a store name:
 * the base slug, then slug-2..slug-99, then a random fallback. The
 * caller picks the first free candidate; the random tail guarantees a
 * usable candidate even when every numeric suffix is taken. Reserved
 * candidates are skipped defensively — the caller still rejects a
 * reserved base slug up front (409 SUBDOMAIN_RESERVED) so a reserved
 * name never silently falls back to a suffix.
 */
export function subdomainCandidates(name: string): string[] {
  const base = slugify(name);
  const candidates: string[] = [];
  if (base !== null && !isReservedSubdomain(base)) {
    candidates.push(base);
    for (let i = 2; i <= 99; i += 1) {
      const suffixed = `${base}-${i}`;
      if (suffixed.length <= MAX_SUBDOMAIN_LENGTH && !isReservedSubdomain(suffixed)) {
        candidates.push(suffixed);
      }
    }
  }
  candidates.push(randomSubdomain(), randomSubdomain(), randomSubdomain());
  return candidates;
}
