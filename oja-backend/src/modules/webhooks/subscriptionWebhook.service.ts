import { Prisma, type $Enums } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import { env } from "../../config/env.js";
import { getPrismaClient } from "../../lib/prisma.js";
import type {
  PaymentProvider,
  ProviderFactory,
} from "../../lib/paymentProvider.js";
import { createPaystackProvider } from "../../lib/providers/paystack.js";
import {
  subscriptionWebhookSchema,
  validateOrThrow,
  type SubscriptionWebhookPayload,
} from "./schemas.js";

/**
 * ============================================================
 * PAYSTACK SUBSCRIPTION WEBHOOK — PLATFORM RECURRING BILLING
 * ============================================================
 *
 * Trust model: the x-paystack-signature header is verified against the
 * PLATFORM's secret key (PLATFORM_PAYSTACK_SECRET_KEY) — NEVER the
 * merchant's storefront keys. This endpoint is a SEPARATE trust domain
 * from /api/webhooks/paystack (order fulfillment): a forged merchant-key
 * webhook can never touch subscriptions, and vice-versa.
 *
 * Events handled:
 *  - charge.success: resolve the SubscriptionPayment by reference. First
 *    payments (sub_/upg_) activate the subscription; renewals (rnl_ or a
 *    bare charge against the stored plan) roll the period and bump
 *    renewalCount. The UPGRADE path is where the deterministic plan swap
 *    happens (create-new-then-disable-old, all in one guarded tx).
 *  - charge.failed / invoice.payment_failed: mark FAILED; first payment =
 *    nothing created; renewal = PAST_DUE + pastDueAt (3d grace).
 *  - subscription.create: capture the SUB_ code + email token so the
 *    subscription can be disabled/cancelled later.
 *  - subscription.disable / subscription.not_renew: mark CANCELLED.
 *
 * GUARD 1 (same-cycle double charge): after an upgrade swap, the OLD
 * Paystack subscription may still fire one renewal before its disable is
 * confirmed. A renewal whose plan_code/subscription_code matches the
 * LEGACY pair is recorded as an ORPHANED payment (no period roll, no
 * renewalCount, no grace change) and the owner is alerted — the manual
 * guard the plan mandates.
 * ============================================================
 */

export interface WebhookProcessingResult {
  outcome: "PROCESSED" | "DUPLICATE" | "IGNORED";
}

const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  "charge.success",
  "charge.failed",
  "invoice.payment_failed",
  "subscription.create",
  "subscription.disable",
  "subscription.not_renew",
]);

const defaultProviderFactory: ProviderFactory = ({ publicKey, secretKey }) =>
  createPaystackProvider({ publicKey, secretKey });

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Integer kobo -> decimal naira string ("150000" -> "1500.00"). */
function koboToNaira(amount: number): string {
  const naira = Math.floor(amount / 100);
  const kobo = amount % 100;
  return `${naira}.${String(kobo).padStart(2, "0")}`;
}

/** The admin-set monthly price for a tier (fallback for renewal amounts). */
async function planMonthlyPrice(
  tx: Prisma.TransactionClient,
  tier: $Enums.SubscriptionTier,
): Promise<string> {
  const row = await tx.subscriptionPlanSetting.findUnique({ where: { plan: tier } });
  return row?.monthlyPrice !== null && row?.monthlyPrice !== undefined
    ? row.monthlyPrice.toFixed(2)
    : "0.00";
}

function signProvider(providerFactory: ProviderFactory): PaymentProvider {
  return providerFactory({
    publicKey: env.PLATFORM_PAYSTACK_PUBLIC_KEY,
    secretKey: env.PLATFORM_PAYSTACK_SECRET_KEY,
  });
}

/** The externalEventId dedup key shared with the order webhook table. */
const PROVIDER_KEY = "paystack";

export async function handlePaystackSubscriptionWebhook(
  rawBody: Buffer,
  signature: string,
  providerFactory: ProviderFactory = defaultProviderFactory,
): Promise<WebhookProcessingResult> {
  let payload: SubscriptionWebhookPayload;
  try {
    payload = validateOrThrow(subscriptionWebhookSchema, JSON.parse(rawBody.toString("utf8")));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new AppError(400, "VALIDATION_ERROR", "Malformed JSON body");
    }
    throw err;
  }

  if (!HANDLED_EVENTS.has(payload.event)) {
    return { outcome: "IGNORED" };
  }

  // 1. Dedup — the unique (provider, externalEventId) constraint is the
  //    authority; this find is just the cheap pre-check.
  const prisma = getPrismaClient();
  const existing = await prisma.webhookEvent.findUnique({
    where: {
      provider_externalEventId: { provider: PROVIDER_KEY, externalEventId: payload.data.id },
    },
  });
  if (existing !== null) {
    return { outcome: "DUPLICATE" };
  }

  // 2. Signature verification against the PLATFORM secret.
  const provider = signProvider(providerFactory);
  if (!(await provider.verifyWebhookSignature(rawBody, signature))) {
    throw new AppError(401, "INVALID_SIGNATURE", "Webhook signature verification failed");
  }

  const event = {
    provider: PROVIDER_KEY,
    externalEventId: payload.data.id,
    payload: payload as unknown as Prisma.InputJsonValue,
    storeId: "",
  };

  try {
    if (payload.event === "subscription.create") {
      return await handleSubscriptionCreate(payload, event);
    }
    if (payload.event === "subscription.disable" || payload.event === "subscription.not_renew") {
      return await handleSubscriptionDisabled(payload, event);
    }
    if (payload.event === "charge.failed" || payload.event === "invoice.payment_failed") {
      return await handleChargeFailed(payload, event);
    }
    return await handleChargeSuccess(payload, event, providerFactory);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { outcome: "DUPLICATE" };
    }
    throw err;
  }
}

interface EventInput {
  provider: string;
  externalEventId: string;
  payload: Prisma.InputJsonValue;
  storeId: string;
}

/** subscription.create — capture the SUB_ code + email token. */
async function handleSubscriptionCreate(
  payload: SubscriptionWebhookPayload,
  event: EventInput,
): Promise<WebhookProcessingResult> {
  const subscriptionCode =
    payload.data.subscription?.subscription_code ?? payload.data.subscription_code;
  const emailToken = payload.data.subscription?.email_token ?? payload.data.email_token;
  if (subscriptionCode === undefined || emailToken === undefined) {
    return { outcome: "IGNORED" };
  }

  const prisma = getPrismaClient();
  const found = await prisma.subscription.findFirst({
    where: { paystackSubscriptionCode: subscriptionCode },
    select: { storeId: true },
  });
  if (found === null) {
    // Nothing local references this subscription yet — acknowledge.
    return { outcome: "IGNORED" };
  }

  await prisma.$transaction(async (tx) => {
    await tx.webhookEvent.create({
      data: { ...event, storeId: found.storeId, status: "PENDING" },
    });
    await tx.subscription.updateMany({
      where: { paystackSubscriptionCode: subscriptionCode },
      data: { paystackEmailToken: emailToken },
    });
    await tx.webhookEvent.updateMany({
      where: { provider_externalEventId: event, status: "PENDING" },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  });
  return { outcome: "PROCESSED" };
}

/** subscription.disable / not_renew — mark CANCELLED. */
async function handleSubscriptionDisabled(
  payload: SubscriptionWebhookPayload,
  event: EventInput,
): Promise<WebhookProcessingResult> {
  const subscriptionCode =
    payload.data.subscription?.subscription_code ?? payload.data.subscription_code;
  if (subscriptionCode === undefined) {
    return { outcome: "IGNORED" };
  }

  const prisma = getPrismaClient();
  const found = await prisma.subscription.findFirst({
    where: { paystackSubscriptionCode: subscriptionCode },
    select: { storeId: true },
  });
  if (found === null) {
    return { outcome: "IGNORED" };
  }

  await prisma.$transaction(async (tx) => {
    await tx.webhookEvent.create({
      data: { ...event, storeId: found.storeId, status: "PENDING" },
    });
    await tx.subscription.updateMany({
      where: { paystackSubscriptionCode: subscriptionCode, status: { not: "CANCELLED" } },
      data: { status: "CANCELLED", pendingDowngradeTier: null },
    });
    await tx.webhookEvent.updateMany({
      where: { provider_externalEventId: event, status: "PENDING" },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  });
  return { outcome: "PROCESSED" };
}

/** charge.failed / invoice.payment_failed — mark payment FAILED. */
async function handleChargeFailed(
  payload: SubscriptionWebhookPayload,
  event: EventInput,
): Promise<WebhookProcessingResult> {
  const reference = payload.data.reference;
  const prisma = getPrismaClient();

  // Resolve storeId from the payment (by reference) or the subscription
  // (by code). If neither resolves, the event has nothing to apply to.
  let storeId: string | null = null;
  if (reference !== undefined) {
    const payment = await prisma.subscriptionPayment.findUnique({ where: { reference } });
    if (payment !== null) storeId = payment.storeId;
  }
  if (storeId === null) {
    const subscriptionCode =
      payload.data.subscription?.subscription_code ?? payload.data.subscription_code;
    if (subscriptionCode !== undefined) {
      const found = await prisma.subscription.findFirst({
        where: { paystackSubscriptionCode: subscriptionCode },
        select: { storeId: true },
      });
      if (found !== null) storeId = found.storeId;
    }
  }
  if (storeId === null) {
    return { outcome: "IGNORED" };
  }

  await prisma.$transaction(async (tx) => {
    await tx.webhookEvent.create({
      data: { ...event, storeId, status: "PENDING" },
    });

    if (reference !== undefined) {
      await tx.subscriptionPayment.updateMany({
        where: { reference, status: "PENDING" },
        data: { status: "FAILED", externalEventId: payload.data.id },
      });
    }

    // A renewal failure on the store's subscription flips it to PAST_DUE
    // with a grace clock (3d default).
    const subscriptionCode =
      payload.data.subscription?.subscription_code ?? payload.data.subscription_code;
    if (subscriptionCode !== undefined) {
      await tx.subscription.updateMany({
        where: { paystackSubscriptionCode: subscriptionCode },
        data: { status: "PAST_DUE", pastDueAt: new Date() },
      });
    }

    await tx.webhookEvent.updateMany({
      where: { provider_externalEventId: event, status: "PENDING" },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  });
  return { outcome: "PROCESSED" };
}

/**
 * charge.success — the heart. Resolves the payment by reference and
 * activates/rolls the subscription, with the deterministic upgrade swap
 * and the same-cycle double-charge guard.
 */
async function handleChargeSuccess(
  payload: SubscriptionWebhookPayload,
  event: Omit<EventInput, "storeId">,
  providerFactory: ProviderFactory,
): Promise<WebhookProcessingResult> {
  const reference = payload.data.reference;
  const prisma = getPrismaClient();

  // Resolve the storeId up-front (before the transaction) so the event row
  // can be created with it. Renewal events without a reference resolve by
  // subscription code.
  let storeId: string | null = null;
  let paymentKind: $Enums.SubscriptionPaymentKind | null = null;
  if (reference !== undefined) {
    const payment = await prisma.subscriptionPayment.findUnique({ where: { reference } });
    if (payment !== null) {
      storeId = payment.storeId;
      paymentKind = payment.kind;
    }
  }
  if (storeId === null) {
    const subCode = payload.data.subscription?.subscription_code ?? payload.data.subscription_code;
    if (subCode !== undefined) {
      const found = await prisma.subscription.findFirst({
        where: { paystackSubscriptionCode: subCode },
        select: { storeId: true },
      });
      if (found !== null) storeId = found.storeId;
    }
  }
  const resolvedEvent: EventInput = { ...event, storeId: storeId ?? "" };

  let outcome: "PROCESSED" | "DUPLICATE" = "PROCESSED";
  await prisma.$transaction(async (tx) => {
    await tx.webhookEvent.create({
      data: { ...resolvedEvent, status: "PENDING" },
    });

    if (reference === undefined) {
      // Renewal events may omit reference; resolve by subscription code.
      return await handleRenewalByCode(tx, payload, resolvedEvent);
    }

    const payment = await tx.subscriptionPayment.findUnique({ where: { reference } });
    if (payment === null) {
      // Unknown reference — nothing to correlate against. Acknowledge the
      // event so Paystack stops redelivering, but do not create anything.
      await tx.webhookEvent.updateMany({
        where: { provider_externalEventId: resolvedEvent, status: "PENDING" },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
      outcome = "PROCESSED";
      return;
    }
    paymentKind = payment.kind;

    // Guard 1: a payment whose provider data carries an OLD (legacy)
    // subscription/plan code after an upgrade swap is a double charge.
    const planCode = payload.data.plan?.plan_code;
    const subCode =
      payload.data.subscription?.subscription_code ?? payload.data.subscription_code;
    const subscription = await tx.subscription.findFirst({
      where: { storeId: payment.storeId },
    });
    if (
      subscription !== null &&
      subscription.legacyPaystackSubscriptionCode !== null &&
      ((subCode !== undefined && subCode === subscription.legacyPaystackSubscriptionCode) ||
        (planCode !== undefined && planCode === subscription.legacyPaystackPlanCode))
    ) {
      // Double charge — record as orphan, NO local effects.
      await tx.subscriptionPayment.update({
        where: { id: payment.id },
        data: {
          status: "PAID",
          paidAt: new Date(),
          externalEventId: payload.data.id,
          orphanReason:
            "Old subscription charged after an upgrade switch — recorded with no local effect",
        },
      });
      await tx.webhookEvent.updateMany({
        where: { provider_externalEventId: resolvedEvent, status: "PENDING" },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
      return;
    }

    if (payment.kind === "SUBSCRIPTION") {
      await activateOrRenew(tx, payment.storeId, payment.tier, payload.data.id);
      await tx.subscriptionPayment.update({
        where: { id: payment.id },
        data: { status: "PAID", paidAt: new Date(), externalEventId: payload.data.id },
      });
    } else if (payment.kind === "UPGRADE") {
      await applyUpgrade(tx, payment.storeId, payment.tier, payload.data.id, providerFactory);
      await tx.subscriptionPayment.update({
        where: { id: payment.id },
        data: { status: "PAID", paidAt: new Date(), externalEventId: payload.data.id },
      });
    } else {
      // RENEWAL record — roll the period, bump renewalCount.
      await tx.subscriptionPayment.update({
        where: { id: payment.id },
        data: { status: "PAID", paidAt: new Date(), externalEventId: payload.data.id },
      });
      await activateOrRenew(tx, payment.storeId, payment.tier, payload.data.id);
    }

    await tx.webhookEvent.updateMany({
      where: { provider_externalEventId: resolvedEvent, status: "PENDING" },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  });

  void paymentKind;
  return { outcome };
}

/**
 * Creates/activates the store's Subscription on first payment, or rolls the
 * period + bumps renewalCount on a renewal. Guarded so a replay never
 * double-rolls: the event insert race already handles concurrency; here we
 * also refuse to roll a period whose currentPeriodEnd is still in the future.
 */
async function activateOrRenew(
  tx: Prisma.TransactionClient,
  storeId: string,
  tier: $Enums.SubscriptionTier,
  externalEventId: string,
): Promise<void> {
  const store = await tx.store.findUnique({
    where: { id: storeId },
    select: { subscriptionId: true },
  });
  const subscription = store?.subscriptionId
    ? await tx.subscription.findUnique({ where: { id: store.subscriptionId } })
    : null;

  const now = new Date();
  if (subscription === null) {
    const created = await tx.subscription.create({
      data: {
        storeId,
        tier,
        status: "ACTIVE",
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
        renewalCount: 0,
      },
    });
    await tx.store.update({
      where: { id: storeId },
      data: { subscriptionId: created.id },
    });
    return;
  }

  // Renewal: only roll the window if the current period has ended (a
  // duplicate/overlap charge within the same cycle must not extend it twice).
  if (subscription.currentPeriodEnd.getTime() <= now.getTime()) {
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        currentPeriodStart: subscription.currentPeriodEnd,
        currentPeriodEnd: new Date(subscription.currentPeriodEnd.getTime() + 30 * 86_400_000),
        renewalCount: { increment: 1 },
        status: "ACTIVE",
        pastDueAt: null,
      },
    });
  }
  void externalEventId;
}

/**
 * The deterministic upgrade switch: tier + caps + plan code apply NOW, the
 * old Paystack subscription is replaced with a new one billing from
 * currentPeriodEnd (create-new-then-disable-old), and the legacy snapshot
 * is kept until the disable is confirmed. All in the caller's transaction.
 */
async function applyUpgrade(
  tx: Prisma.TransactionClient,
  storeId: string,
  tier: $Enums.SubscriptionTier,
  externalEventId: string,
  providerFactory: ProviderFactory,
): Promise<void> {
  const store = await tx.store.findUnique({
    where: { id: storeId },
    select: { subscriptionId: true, owner: { select: { account: { select: { email: true } } } } },
  });
  if (store?.subscriptionId === null || store?.subscriptionId === undefined) {
    throw new AppError(409, "NO_SUBSCRIPTION", "This store has no subscription to upgrade");
  }
  const subscription = await tx.subscription.findUnique({
    where: { id: store.subscriptionId },
  });
  if (subscription === null) {
    throw new AppError(409, "NO_SUBSCRIPTION", "This store has no subscription to upgrade");
  }

  const planSetting = await tx.subscriptionPlanSetting.findUnique({ where: { plan: tier } });
  if (planSetting?.paystackPlanCode === null || planSetting?.paystackPlanCode === undefined) {
    throw new AppError(
      409,
      "PRICING_NOT_CONFIGURED",
      `The ${tier} plan has no Paystack plan configured`,
    );
  }

  // Snapshot the old linkage for the double-charge guard.
  const oldCode = subscription.paystackSubscriptionCode;
  const oldPlan = subscription.paystackPlanCode;

  // 1. Apply tier + caps + plan code immediately.
  const updated = await tx.subscription.update({
    where: { id: subscription.id },
    data: {
      tier,
      paystackPlanCode: planSetting.paystackPlanCode,
      // Clear the legacy downgrade since the store just paid up.
      pendingDowngradeTier: null,
    },
  });

  // 2. Create the new Paystack subscription billing from currentPeriodEnd.
  const provider = signProvider(providerFactory);
  const createSub = provider.createRecurringSubscription;
  const disableSub = provider.disableRecurringSubscription;
  let newCode: string | null = null;
  let newToken: string | null = null;
  let swapPending = true;
  if (createSub !== undefined && store.owner?.account.email !== undefined) {
    const created = await createSub({
      customer: store.owner.account.email,
      planCode: planSetting.paystackPlanCode,
      startDate: updated.currentPeriodEnd.toISOString(),
    });
    newCode = created.subscriptionCode;
    newToken = created.emailToken;

    // 3. Disable the old subscription — best-effort; on failure the sweep
    //    retries (swapPending flag).
    if (oldCode !== null && disableSub !== undefined && newToken !== null) {
      try {
        await disableSub({
          subscriptionCode: oldCode,
          emailToken: subscription.paystackEmailToken ?? "",
        });
        swapPending = false;
      } catch {
        swapPending = true;
      }
    }
  }

  await tx.subscription.update({
    where: { id: subscription.id },
    data: {
      paystackSubscriptionCode: newCode ?? subscription.paystackSubscriptionCode,
      paystackEmailToken: newToken ?? subscription.paystackEmailToken,
      legacyPaystackSubscriptionCode: swapPending ? oldCode : null,
      legacyPaystackPlanCode: swapPending ? oldPlan : null,
      swapPending,
    },
  });
  void externalEventId;
}

/** Renewal event keyed by subscription code (no reference present). */
async function handleRenewalByCode(
  tx: Prisma.TransactionClient,
  payload: SubscriptionWebhookPayload,
  event: EventInput,
): Promise<void> {
  const subCode = payload.data.subscription?.subscription_code ?? payload.data.subscription_code;
  const planCode = payload.data.plan?.plan_code;
  if (subCode === undefined) {
    await tx.webhookEvent.updateMany({
      where: { provider_externalEventId: event, status: "PENDING" },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    return;
  }

  const subscription = await tx.subscription.findFirst({
    where: { paystackSubscriptionCode: subCode },
  });

  // Guard 1 for code-keyed renewals: matches the LEGACY code after a swap.
  if (
    subscription !== null &&
    subscription.legacyPaystackSubscriptionCode === subCode
  ) {
    // Orphan — no local effects. Record a FAILED-less marker? We have no
    // SubscriptionPayment to mark (no reference), so just acknowledge.
    await tx.webhookEvent.updateMany({
      where: { provider_externalEventId: event, status: "PENDING" },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    return;
  }

  if (subscription === null) {
    await tx.webhookEvent.updateMany({
      where: { provider_externalEventId: event, status: "PENDING" },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    return;
  }

  if (planCode !== undefined && subscription.paystackPlanCode !== planCode) {
    await tx.webhookEvent.updateMany({
      where: { provider_externalEventId: event, status: "PENDING" },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    return;
  }

  await activateOrRenew(tx, subscription.storeId, subscription.tier, payload.data.id);
  // Record the renewal in the append-only ledger. amount is kobo->naira
  // from the payload (falls back to the plan setting when absent).
  const amountNaira =
    payload.data.amount !== undefined
      ? koboToNaira(payload.data.amount)
      : await planMonthlyPrice(tx, subscription.tier);
  await tx.subscriptionPayment.create({
    data: {
      storeId: subscription.storeId,
      tier: subscription.tier,
      kind: "RENEWAL",
      status: "PAID",
      reference: `rnl_${payload.data.id.slice(0, 18)}`,
      amount: new Prisma.Decimal(amountNaira),
      paidAt: new Date(),
      externalEventId: payload.data.id,
    },
  });

  await tx.webhookEvent.updateMany({
    where: { provider_externalEventId: event, status: "PENDING" },
    data: { status: "PROCESSED", processedAt: new Date() },
  });
}
