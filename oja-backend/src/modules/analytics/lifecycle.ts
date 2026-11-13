import type { $Enums } from "../../../generated/prisma/client.js";
import type { Granularity } from "./constants.js";
import { buildTimeBuckets } from "./utils.js";

/**
 * Platform lifecycle definitions — the ONE place churn, activation, and
 * signup-bucketing policy lives. Merchant dashboards and the admin health
 * endpoints call these same helpers; changing a definition means editing
 * this file once, never individual queries.
 */

/**
 * Subscription statuses that count as CHURNED — a store whose subscription
 * transitioned from ACTIVE to one of these during the reporting period.
 * CANCELLED is the only terminal non-active status today; EXPIRED joins
 * the list when subscriptions auto-expire.
 */
export const CHURNED_STATUSES: readonly $Enums.SubscriptionStatus[] = ["CANCELLED"];

/**
 * Activation proxy window: a store counts as activated when it published
 * (created, non-soft-deleted) at least one product within this many
 * milliseconds of store creation. There is no storefront "live" flag yet,
 * so this is an OPERATIONAL PROXY — replaced by a true activation event
 * later without any API contract change.
 */
export const ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Churn rate = churned / activeAtStart, as a percentage rounded to one
 * decimal. Returns null when there is no baseline (activeAtStart <= 0) or
 * on any negative input — a rate without a denominator is meaningless.
 */
export function computeChurnRate(churned: number, activeAtStart: number): number | null {
  if (churned < 0 || activeAtStart <= 0) return null;
  return Math.round((churned / activeAtStart) * 1000) / 10;
}

/**
 * Activation rate = activated / created, as a percentage rounded to one
 * decimal. Returns null when no stores were created (no denominator).
 */
export function computeActivationRate(activated: number, created: number): number | null {
  if (activated < 0 || created <= 0) return null;
  return Math.round((activated / created) * 1000) / 10;
}

export interface UtcBucketCount {
  start: string;
  end: string;
  count: number;
}

/**
 * Counts events (stores created, signups, …) into the UTC buckets of the
 * half-open range [start, end), aligned like the analytics timeseries:
 * daily to UTC midnight, weekly to Monday 00:00 UTC. Every bucket appears
 * zero-filled; events outside the range are ignored defensively.
 */
export function countEventsByUtcBucket(
  events: readonly { createdAt: Date }[],
  start: Date,
  end: Date,
  granularity: Granularity,
): UtcBucketCount[] {
  const buckets = buildTimeBuckets(start, end, granularity);
  const counts = new Array<number>(buckets.length).fill(0);

  for (const event of events) {
    const at = event.createdAt.getTime();
    if (at < start.getTime() || at >= end.getTime()) continue;
    const index = buckets.findIndex(
      (bucket) => at >= bucket.start.getTime() && at < bucket.end.getTime(),
    );
    if (index !== -1) counts[index] = (counts[index] ?? 0) + 1;
  }

  return buckets.map((bucket, index) => ({
    start: bucket.start.toISOString(),
    end: bucket.end.toISOString(),
    count: counts[index] ?? 0,
  }));
}
