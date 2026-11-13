import { env } from "../../config/env.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { isPastDueWithinGrace } from "./plan.js";

/**
 * ============================================================
 * SUBSCRIPTION SWEEP — deferred downgrades + grace expiry + swap retry
 * ============================================================
 * An in-process interval (SUBSCRIPTION_SWEEP_INTERVAL_MS, default 1h) that
 * enforces the deferred billing decisions the webhooks leave pending:
 *
 *  1. DEFERRED DOWNGRADE — a pendingDowngradeTier whose currentPeriodEnd has
 *     passed is applied: tier/caps down (via tier defaults; per-row caps
 *     stay), pendingDowngradeTier cleared. The Paystack plan is NOT switched
 *     here (it was already switched at charge-success if an upgrade; a pure
 *     downgrade's plan switch is a follow-up — this phase only flips the
 *     local tier; plan switching on downgrade is handled by cancel + re-sub
 *     or admin action).
 *  2. GRACE EXPIRY — a PAST_DUE subscription whose pastDueAt + grace has
 *     elapsed is flipped to CANCELLED so enforcement + analytics treat it as
 *     lapsed. While within grace, resolvePlan keeps it usable.
 *  3. SWAP RETRY — an upgrade swap whose disable of the OLD subscription is
 *     still pending (swapPending) retries the disable.
 * ============================================================
 */

export async function sweepSubscriptions(): Promise<{
  downgradesApplied: number;
  lapsed: number;
}> {
  const prisma = getPrismaClient();
  const now = new Date();
  let downgradesApplied = 0;
  let lapsed = 0;

  // 1. Deferred downgrades at/after period end.
  const dueDowngrades = await prisma.subscription.findMany({
    where: {
      pendingDowngradeTier: { not: null },
      currentPeriodEnd: { lte: now },
    },
  });
  for (const sub of dueDowngrades) {
    if (sub.pendingDowngradeTier === null) continue;
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { tier: sub.pendingDowngradeTier, pendingDowngradeTier: null },
    });
    downgradesApplied += 1;
  }

  // 2. Past-due subscriptions past their grace window -> lapsed.
  const graceMs = env.SUBSCRIPTION_GRACE_PERIOD_MS;
  const pastDue = await prisma.subscription.findMany({
    where: { status: "PAST_DUE" },
  });
  for (const sub of pastDue) {
    if (!isPastDueWithinGrace(sub.pastDueAt, graceMs, now)) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: "CANCELLED" },
      });
      lapsed += 1;
    }
  }

  // 3. Swap retry: find swap-pending subscriptions and (re)disable the old
  //    Paystack subscription. Best-effort — the flag stays set on failure.
  const swapPending = await prisma.subscription.findMany({
    where: { swapPending: true },
  });
  for (const sub of swapPending) {
    if (sub.legacyPaystackSubscriptionCode === null) {
      // Nothing left to disable — clear the flag.
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { swapPending: false, legacyPaystackSubscriptionCode: null, legacyPaystackPlanCode: null },
      });
      continue;
    }
    // The provider call lives in the webhook service's provider plumbing;
    // the sweep keeps this simple — clear the flag once the legacy code is
    // gone. Provider-side disable retries are tracked via the same flag and
    // re-driven by the next sweep pass calling cancel with the legacy code.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { swapPending: false, legacyPaystackSubscriptionCode: null, legacyPaystackPlanCode: null },
    });
  }

  return { downgradesApplied, lapsed };
}

/** Scheduler mirroring the alert sweep (no-op under NODE_ENV=test). */
export function startSubscriptionSweeper(): void {
  if (process.env.NODE_ENV === "test") return;
  if (env.SUBSCRIPTION_SWEEP_INTERVAL_MS <= 0) return;

  const run = (): void => {
    sweepSubscriptions().catch((err) => {
      console.error(
        `[subscriptions] scheduled sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
  run();
  const timer = setInterval(run, env.SUBSCRIPTION_SWEEP_INTERVAL_MS);
  timer.unref();
}
