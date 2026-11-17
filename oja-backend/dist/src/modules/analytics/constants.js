/**
 * Single source of truth for analytics policy. Every endpoint and KPI in
 * this module reads from these constants — change the sale definition
 * once here, and summary/timeseries/trends/staff-performance all follow.
 */
/** Order statuses that count as a successful sale for analytics. */
export const SALES_STATUSES = ["PAID", "SHIPPED"];
/**
 * Every channel of the revenue-by-channel breakdown, in display order.
 * Zero-filled per channel when a range has no sales in it.
 */
export const CHANNELS = [
    "POS",
    "STOREFRONT",
    "DIRECT",
    "SOCIAL",
    "MARKETPLACE",
    "REFERRAL",
];
/** Longest allowed analytics range (bounds the bucket count). */
export const MAX_RANGE_DAYS = 366;
export const MIN_TOP = 1;
export const MAX_TOP = 50;
export const DEFAULT_TOP = 5;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const GRANULARITIES = ["daily", "weekly"];
//# sourceMappingURL=constants.js.map