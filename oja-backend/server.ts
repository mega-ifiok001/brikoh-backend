import "dotenv/config";
import { createApp } from "./app.js";
import { env } from "./src/config/env.js";
import { startAlertScheduler } from "./src/modules/notifications/service.js";
import { startExpirySweep } from "./src/modules/orders/service.js";
import { startSubscriptionSweeper } from "./src/modules/subscriptions/sweep.js";

const app = createApp();

// Merchant-alert sweep (low stock / expiring soon). Best-effort
// in-process timer; a no-op under NODE_ENV=test where tests invoke the
// sweep directly (see dashboard-notifications.md).
startAlertScheduler();

// Bank-transfer expiry sweep: reclaims stale AWAITING_PAYMENT claims back to
// PENDING. Same NODE_ENV=test no-op convention.
startExpirySweep();

// Subscription sweep: deferred downgrades, grace expiry, swap retries.
// Same NODE_ENV=test no-op convention.
startSubscriptionSweeper();

// The wired transactional-email channel (mirrors the sender factories in
// the auth controller). Printed at boot so the deploy's email wiring is
// visible in Render's Logs tab without digging through env vars.
const emailChannel =
  env.NODE_ENV === "test"
    ? "console stub"
    : `Resend (from: ${env.RESEND_FROM_EMAIL_ACCOUNT} / ${env.RESEND_FROM_EMAIL_INVITE} / ${env.RESEND_FROM_EMAIL_ALERT})`;

app.listen(env.PORT, () => {
  console.log(`Brikoh API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  console.log(`Brikoh email channel: ${emailChannel}`);
});
