import { Prisma } from "../../../generated/prisma/client.js";
import { AppError } from "../../lib/AppError.js";
import type { ProviderFactory } from "../../lib/paymentProvider.js";
import { createPaystackProvider } from "../../lib/providers/paystack.js";
import { getPrismaClient } from "../../lib/prisma.js";
import { decryptSecret } from "../../lib/secrets.js";
import { recordSaleStockChanges } from "../products/ledger.service.js";
import { defaultAlertSender } from "../notifications/email.js";
import { notifyPaymentReceived, NOTIFICATION_REF_TYPES } from "../notifications/service.js";
import { sendCustomerReceiptWithDefault } from "../receipts/service.js";
import { creditWallet } from "../wallet/service.js";
import { paystackWebhookSchema, validateOrThrow, type PaystackWebhookPayload } from "./schemas.js";

/**
 * ============================================================
 * PAYSTACK WEBHOOK HANDLER — ORDER FULFILLMENT ON PAYMENT
 * ============================================================
 *
 * Trust model: the `x-paystack-signature` header IS the credential. The
 * signature is verified with the store's OWN secret key, decrypted from
 * the store's PaymentCredential row — never from client input, never
 * logged. This endpoint is deliberately unauthenticated (no JWTs); its
 * security is the HMAC + the uniqueness of the payment reference.
 *
 * ORDER OF OPERATIONS (spec-mandated):
 *   1. Dedup gate — the (provider, externalEventId) unique constraint is
 *      the FIRST authority. Already-seen events short-circuit to 200
 *      without any further work, so redeliveries are free.
 *   2. Order resolution from the payment reference (404 when unknown —
 *      nothing to verify against, so no signature attempt is made).
 *   3. Credential resolution (409 when gone — the signature cannot be
 *      checked without the store's secret).
 *   4. HMAC-SHA512 verification (401 on mismatch).
 *   5. Processing in ONE transaction: charge.success marks the order
 *      PAID and decrements stock via the ledger sale path; charge.failed
 *      marks it FAILED and never touches stock. The event row is created
 *      inside the transaction FIRST, so a concurrent redelivery loses
 *      the insert race and gets a 200 DUPLICATE. Any failure (e.g.
 *      INSUFFICIENT_STOCK) rolls the whole transaction back, nothing is
 *      half-applied, and Paystack redelivers later.
 *
 * Unknown event types are acknowledged without verification or any
 * write: Paystack stops redelivering and nothing in our data changes.
 * ============================================================
 */

export interface WebhookProcessingResult {
  /** What this delivery did: PROCESSED (real work), DUPLICATE (already handled), IGNORED (unknown event). */
  outcome: "PROCESSED" | "DUPLICATE" | "IGNORED";
}

const PROVIDER_KEY = "paystack";

const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  "charge.success",
  "charge.failed",
  "transfer.success",
  "transfer.failed",
]);

const defaultProviderFactory: ProviderFactory = ({ publicKey, secretKey }) =>
  createPaystackProvider({ publicKey, secretKey });

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function handlePaystackWebhook(
  rawBody: Buffer,
  signature: string,
  providerFactory: ProviderFactory = defaultProviderFactory,
): Promise<WebhookProcessingResult> {
  let payload: PaystackWebhookPayload;
  try {
    payload = validateOrThrow(paystackWebhookSchema, JSON.parse(rawBody.toString("utf8")));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new AppError(400, "VALIDATION_ERROR", "Malformed JSON body");
    }
    throw err;
  }

  // Unknown event types are acknowledged and ignored — before any
  // verification or write, so arbitrary provider events never fail
  // (Paystack would otherwise redeliver forever).
  if (!HANDLED_EVENTS.has(payload.event)) {
    return { outcome: "IGNORED" };
  }

  const prisma = getPrismaClient();

  // 1. Dedup gate — the unique constraint is the real authority; the
  //    find is just the cheap pre-check (the insert race is caught by
  //    P2002 inside the transaction).
  const existing = await prisma.webhookEvent.findUnique({
    where: {
      provider_externalEventId: {
        provider: PROVIDER_KEY,
        externalEventId: payload.data.id,
      },
    },
  });
  if (existing !== null) {
    return { outcome: "DUPLICATE" };
  }

  // 2. Source resolution. charge.* events resolve the ORDER from the
  //    echoed payment reference; transfer.* events resolve the PAYOUT
  //    from the transfer code (or the wd_… reference). The store is
  //    always derived from the resolved row, never from the payload.
  let storeId: string;
  let orderId: string | null = null;
  let orderStatus: string | null = null;
  let payoutId: string | null = null;
  if (payload.event.startsWith("transfer.")) {
    const payout = await resolvePayout(payload.data.transfer_code, payload.data.reference);
    storeId = payout.storeId;
    payoutId = payout.id;
  } else {
    const order = await prisma.order.findFirst({
      where: { paymentReference: payload.data.reference },
      select: { id: true, storeId: true, status: true },
    });
    if (order === null) {
      throw new AppError(404, "ORDER_NOT_FOUND", "No order matches this payment reference");
    }
    storeId = order.storeId;
    orderId = order.id;
    orderStatus = order.status;
  }

  // 3. Credentials — without the store's secret there is nothing to
  //    verify the signature against.
  const credential = await prisma.paymentCredential.findUnique({
    where: { storeId_provider: { storeId, provider: PROVIDER_KEY } },
  });
  if (credential === null) {
    throw new AppError(
      409,
      "PAYMENT_NOT_CONFIGURED",
      "This store has no payment credentials configured",
    );
  }

  // 4. Signature verification over the EXACT raw bytes.
  const provider = providerFactory({
    publicKey: credential.publicKey,
    secretKey: decryptSecret(credential.secretKeyEncrypted),
  });
  if (!(await provider.verifyWebhookSignature(rawBody, signature))) {
    throw new AppError(401, "INVALID_SIGNATURE", "Webhook signature verification failed");
  }

  // 5. Processing.
  const eventData = {
    storeId,
    provider: PROVIDER_KEY,
    externalEventId: payload.data.id,
    payload: payload as Prisma.InputJsonValue,
  };

  if (payload.event === "charge.failed") {
    return handleChargeFailed(orderId!, orderStatus!, eventData);
  }
  if (payload.event === "transfer.success") {
    return handleTransferSuccess(payoutId!, storeId, eventData);
  }
  if (payload.event === "transfer.failed") {
    return handleTransferFailed(payoutId!, storeId, eventData);
  }
  return handleChargeSuccess(orderId!, orderStatus!, eventData);
}

interface EventInput {
  storeId: string;
  provider: string;
  externalEventId: string;
  payload: Prisma.InputJsonValue;
}

/** Provider fees arrive in the currency's minor unit (kobo). */
function feeFromEvent(event: EventInput, key: "fee" | "fees"): Prisma.Decimal | null {
  const payload = event.payload as { data?: Record<string, unknown> };
  const value = payload.data?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? new Prisma.Decimal(value).div(100)
    : null;
}

/**
 * Records an event as already-processed without touching the order —
 * used when the order is no longer PENDING (already paid, cancelled,
 * failed…). Never resurrects a finalized order and never decrements
 * stock twice.
 */
async function recordProcessedEvent(event: EventInput): Promise<WebhookProcessingResult> {
  try {
    await getPrismaClient().webhookEvent.create({
      data: { ...event, status: "PROCESSED", processedAt: new Date() },
    });
    return { outcome: "PROCESSED" };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { outcome: "DUPLICATE" };
    }
    throw err;
  }
}

async function handleChargeSuccess(
  orderId: string,
  orderStatus: string,
  event: EventInput,
): Promise<WebhookProcessingResult> {
  if (orderStatus !== "PENDING") {
    // Money arrived for an order that is no longer pending — record the
    // delivery and change nothing (no double decrement, no resurrection).
    return recordProcessedEvent(event);
  }

  const prisma = getPrismaClient();
  let paid = false;
  try {
    await prisma.$transaction(async (tx) => {
      // The event row is the race gate: a concurrent redelivery fails the
      // unique insert and the whole transaction (including the decrement)
      // never happens.
      const created = await tx.webhookEvent.create({ data: { ...event, status: "PENDING" } });

      // Guarded transition: only a still-PENDING order becomes PAID (and
      // the stock decrement + wallet credit only happen on that transition).
      paid = await applyChargeSuccessEffects(
        tx,
        orderId,
        event.storeId,
        feeFromEvent(event, "fees"),
      );

      await tx.webhookEvent.update({
        where: { id: created.id },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { outcome: "DUPLICATE" };
    }
    throw err;
  }

  // The money is committed; the merchant alert fires after commit and is
  // best-effort (a send failure never fails the webhook response).
  if (paid) {
    await notifyPaymentReceived(
      defaultAlertSender(),
      event.storeId,
      NOTIFICATION_REF_TYPES.ORDER,
      orderId,
    );
    await sendCustomerReceiptWithDefault(event.storeId, NOTIFICATION_REF_TYPES.ORDER, orderId);
  }
  return { outcome: "PROCESSED" };
}

/**
 * The guarded status→PAID transition plus the stock decrement, with NO
 * wallet credit. Shared by the CARD flow (applyChargeSuccessEffects adds the
 * wallet credit on top) and the manual bank-transfer confirm (which credits
 * nothing — the merchant records receipt out of band). The `fromStatus`
 * guard makes the claim atomic: exactly one caller wins the transition, so a
 * concurrent confirm + expiry sweep can't both move stock. Returns false when
 * the order was no longer in `fromStatus` (nothing changed).
 */
export async function markOrderPaidAndDecrementStock(
  tx: Prisma.TransactionClient,
  orderId: string,
  storeId: string,
  opts: {
    fromStatus?: "PENDING" | "AWAITING_PAYMENT";
    amountPaid?: Prisma.Decimal | null;
    paymentFee?: Prisma.Decimal;
  } = {},
): Promise<boolean> {
  const fromStatus = opts.fromStatus ?? "PENDING";
  const data: Prisma.OrderUpdateInput = { status: "PAID", paidAt: new Date() };
  if (opts.amountPaid !== undefined) {
    data.amountPaid = opts.amountPaid;
  }
  if (opts.paymentFee !== undefined) {
    data.paymentFee = opts.paymentFee;
  }
  const updated = await tx.order.updateMany({
    where: { id: orderId, storeId, status: fromStatus },
    data,
  });
  if (updated.count === 0) {
    return false;
  }

  const [order, lineItems] = await Promise.all([
    tx.order.findUnique({
      where: { id: orderId },
      select: { branchId: true, total: true },
    }),
    tx.orderLineItem.findMany({
      where: { orderId },
      select: { productId: true, variantId: true, quantity: true },
    }),
  ]);
  if (order === null || order.branchId === null) {
    throw new AppError(
      500,
      "ORDER_BRANCH_MISSING",
      "Order has no branch — cannot attribute its stock movement",
    );
  }
  await recordSaleStockChanges(
    tx,
    lineItems.map((item) => ({
      storeId,
      branchId: order.branchId,
      productId: item.productId,
      variantId: item.variantId ?? undefined,
      quantityChange: -item.quantity,
    })),
  );
  return true;
}

/**
 * The order-fulfillment half of charge.success, shared by the live
 * webhook handler and the admin replay path: the guarded PENDING→PAID
 * transition plus the stock decrement, then the wallet credit (the CARD
 * sale's money enters the wallet exactly when it's confirmed paid — same
 * transaction, so the credit can never be separated from the PAID
 * transition, or double-credited on replay). Returns false when the order
 * was no longer pending (nothing changed — no double decrement).
 */
export async function applyChargeSuccessEffects(
  tx: Prisma.TransactionClient,
  orderId: string,
  storeId: string,
  paymentFee: Prisma.Decimal | null = null,
): Promise<boolean> {
  const paid = await markOrderPaidAndDecrementStock(tx, orderId, storeId, {
    ...(paymentFee !== null ? { paymentFee } : {}),
  });
  if (!paid) {
    return false;
  }

  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { branchId: true, total: true },
  });
  if (order?.branchId === null) {
    throw new AppError(
      500,
      "ORDER_BRANCH_MISSING",
      "Order has no branch — cannot attribute its stock movement",
    );
  }
  if (order !== null && paymentFee !== null && paymentFee.greaterThan(order.total)) {
    throw new AppError(500, "PAYMENT_FEE_INVALID", "Provider fee exceeds the transaction amount");
  }
  await creditWallet(tx, storeId, {
    amount: order!.total.sub(paymentFee ?? new Prisma.Decimal(0)),
    orderId,
    source: "ORDER_PAYMENT",
  });
  return true;
}

async function handleChargeFailed(
  orderId: string,
  orderStatus: string,
  event: EventInput,
): Promise<WebhookProcessingResult> {
  if (orderStatus !== "PENDING") {
    return recordProcessedEvent(event);
  }

  const prisma = getPrismaClient();
  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.webhookEvent.create({ data: { ...event, status: "PENDING" } });
      // Stock is NEVER touched on failure.
      await tx.order.updateMany({
        where: { id: orderId, status: "PENDING" },
        data: { status: "FAILED" },
      });
      await tx.webhookEvent.update({
        where: { id: created.id },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
      return { outcome: "PROCESSED" };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { outcome: "DUPLICATE" };
    }
    throw err;
  }
}

/**
 * Resolves the payout an event refers to, by transfer code (the
 * reliable key) falling back to the wd_… reference. 404 when neither
 * matches — nothing to verify against.
 */
async function resolvePayout(
  transferCode: string | undefined,
  reference: string,
): Promise<{ id: string; storeId: string; status: string }> {
  const prisma = getPrismaClient();
  const payout = await prisma.payout.findFirst({
    where: {
      OR: [
        ...(transferCode !== undefined && transferCode.length > 0 ? [{ transferCode }] : []),
        { reference },
      ],
    },
  });
  if (payout === null) {
    throw new AppError(404, "PAYOUT_NOT_FOUND", "No payout matches this transfer");
  }
  return { id: payout.id, storeId: payout.storeId, status: payout.status };
}

/**
 * transfer.success: the money moved. Only a still-REQUESTED/PROCESSING
 * payout transitions to SUCCESS; an already-terminal payout is recorded
 * as processed with no further change (idempotent redelivery).
 */
async function handleTransferSuccess(
  payoutId: string,
  storeId: string,
  event: EventInput,
): Promise<WebhookProcessingResult> {
  const prisma = getPrismaClient();
  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.webhookEvent.create({ data: { ...event, status: "PENDING" } });
      await tx.payout.updateMany({
        where: { id: payoutId, status: { in: ["REQUESTED", "PROCESSING"] } },
        data: {
          status: "SUCCESS",
          processedAt: new Date(),
          ...(feeFromEvent(event, "fee") !== null ? { fee: feeFromEvent(event, "fee")! } : {}),
        },
      });
      await tx.webhookEvent.update({
        where: { id: created.id },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
      return { outcome: "PROCESSED" };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { outcome: "DUPLICATE" };
    }
    throw err;
  }
}

/**
 * transfer.failed: the money never moved. Only a still-REQUESTED/
 * PROCESSING payout transitions to FAILED — and the debit is reversed
 * ONLY on that transition (a WITHDRAWAL_REVERSAL credit), so a
 * redelivered failed event can never double-reverse.
 */
async function handleTransferFailed(
  payoutId: string,
  storeId: string,
  event: EventInput,
): Promise<WebhookProcessingResult> {
  const prisma = getPrismaClient();
  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.webhookEvent.create({ data: { ...event, status: "PENDING" } });
      const amount = await tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
      const updated = await tx.payout.updateMany({
        where: { id: payoutId, status: { in: ["REQUESTED", "PROCESSING"] } },
        data: { status: "FAILED", processedAt: new Date() },
      });
      if (updated.count === 1) {
        await creditWallet(tx, storeId, {
          amount: amount.amount,
          payoutId,
          source: "WITHDRAWAL_REVERSAL",
        });
      }
      await tx.webhookEvent.update({
        where: { id: created.id },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
      return { outcome: "PROCESSED" };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { outcome: "DUPLICATE" };
    }
    throw err;
  }
}

/**
 * Admin replay: re-runs a STORED webhook payload through the same
 * fulfillment pipeline (applyChargeSuccessEffects / the failed
 * transition) without re-verifying a signature and without creating a
 * new event row. Only events that were never PROCESSED (PENDING/FAILED,
 * no processedAt) are eligible — a processed event must never decrement
 * stock a second time.
 */
export async function reprocessWebhookEvent(
  eventId: string,
  providerFactory: ProviderFactory = defaultProviderFactory,
): Promise<WebhookProcessingResult> {
  void providerFactory;
  const prisma = getPrismaClient();
  const event = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
  if (event === null) {
    throw new AppError(404, "ADMIN_EVENT_NOT_FOUND", "Webhook event not found");
  }
  if (event.status === "PROCESSED" || event.processedAt !== null) {
    throw new AppError(
      409,
      "WEBHOOK_ALREADY_PROCESSED",
      "This webhook was already processed; replays run no business effect",
    );
  }

  let payload: PaystackWebhookPayload;
  try {
    payload = validateOrThrow(paystackWebhookSchema, event.payload);
  } catch {
    throw new AppError(400, "INVALID_PAYLOAD", "The stored webhook payload no longer parses");
  }

  const order = await prisma.order.findFirst({
    where: { paymentReference: payload.data.reference },
  });
  if (order === null) {
    throw new AppError(404, "ORDER_NOT_FOUND", "No order matches this payment reference");
  }

  // A non-pending order is finalized: replay records the delivery and
  // changes nothing (no double decrement, no resurrection).
  if (order.status !== "PENDING") {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    return { outcome: "PROCESSED" };
  }

  await prisma.$transaction(async (tx) => {
    if (payload.event === "charge.failed") {
      await tx.order.updateMany({
        where: { id: order.id, status: "PENDING" },
        data: { status: "FAILED" },
      });
    } else {
      await applyChargeSuccessEffects(tx, order.id, event.storeId);
    }
    await tx.webhookEvent.update({
      where: { id: event.id },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  });

  // Admin replay of a payment that fulfilled an order — alert the owner
  // exactly like the live webhook path (deduped on the ORDER ref, so a
  // replay after a failed original send delivers the one missing alert).
  if (payload.event === "charge.success" && order.status === "PENDING") {
    await notifyPaymentReceived(
      defaultAlertSender(),
      event.storeId,
      NOTIFICATION_REF_TYPES.ORDER,
      order.id,
    );
  }
  return { outcome: "PROCESSED" };
}
