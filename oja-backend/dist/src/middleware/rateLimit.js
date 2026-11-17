import { AppError } from "../lib/AppError.js";
const buckets = new Map();
// Each rateLimit() call is its own limiter instance; namespace its buckets so
// routes don't compete for a single per-IP bucket (otherwise the first limiter
// to open a window in a 60s span would impose its `max` on every other route).
let nextLimiterId = 0;
/**
 * Fixed-window in-memory rate limiter keyed by client IP. Suitable for a
 * single-instance deployment; a shared store (Redis) replaces this when
 * horizontal scaling lands. Mounted on the auth route group.
 */
export function rateLimit(options) {
    const limiterId = nextLimiterId++;
    return (req, res, next) => {
        void res;
        const key = `${limiterId}:${req.ip ?? "unknown"}`;
        const now = Date.now();
        const bucket = buckets.get(key);
        if (bucket === undefined || bucket.resetAt <= now) {
            buckets.set(key, { count: 1, resetAt: now + options.windowMs });
            next();
            return;
        }
        bucket.count += 1;
        if (bucket.count > options.max) {
            res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
            next(new AppError(429, "RATE_LIMITED", "Too many requests — please wait a moment and try again"));
            return;
        }
        next();
    };
}
//# sourceMappingURL=rateLimit.js.map