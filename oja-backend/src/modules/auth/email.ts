import { env } from "../../config/env.js";
import { APP_NAME } from "../../lib/email/branding.js";
import { escapeHtml, renderEmailLayout } from "../../lib/email/layout.js";
import { sendBuiltEmail, type ResendEmailClient } from "../../lib/email/resend.js";
import { formatHumanDate } from "../../lib/format-date.js";
import type {
  PasswordResetEmailData,
  PasswordResetEmailSender,
  VerificationEmailData,
  VerificationEmailSender,
} from "./service.js";

export { createResendClient, type ResendEmailClient } from "../../lib/email/resend.js";

export interface BuiltVerificationEmail {
  subject: string;
  html: string;
  text: string;
}

/** Builds the HTTPS URL that web and native apps register for email verification. */
export function buildVerificationLink(token: string): string {
  const link = new URL("/verify-email", env.FRONTEND_URL);
  link.searchParams.set("token", token);
  return link.toString();
}

/**
 * Builds the HTML + text verification email. The expiry is rendered
 * through the shared human-date utility (never a raw UTC string). The
 * token value itself is never HTML-escaped into the page text — it only
 * travels in the href, and generated tokens are URL-safe base64url.
 */
export function buildVerificationEmail(data: VerificationEmailData): BuiltVerificationEmail {
  const verifyLink = buildVerificationLink(data.token);
  const expiry = formatHumanDate(data.expiresAt);

  const subject = `Verify your email on ${APP_NAME}`;

  const text = [
    `Welcome to ${APP_NAME} — one more step to go.`,
    "",
    "Verify your email address to finish setting up your store:",
    "",
    `Verify my email: ${verifyLink}`,
    "",
    `This link expires on ${expiry}.`,
    "",
    `If you didn't create an account on ${APP_NAME}, you can ignore this email.`,
  ].join("\n");

  const html = renderEmailLayout({
    title: `Verify your email on ${APP_NAME}`,
    body: [
      `<p style="margin:0 0 24px;color:#52525b;">Welcome to ${APP_NAME}. Verify your email address to finish setting up your store.</p>`,
    ],
    cta: { label: "Verify my email", href: verifyLink },
    footer: [
      `This link expires on ${expiry}.`,
      `If you didn't create an account on ${APP_NAME}, you can ignore this email.`,
    ],
  });

  return { subject, html, text };
}

export class ResendVerificationSender implements VerificationEmailSender {
  constructor(
    private readonly client: ResendEmailClient,
    private readonly fromEmail: string,
  ) {}

  async sendVerificationEmail(data: VerificationEmailData): Promise<void> {
    await sendBuiltEmail(this.client, this.fromEmail, data.to, buildVerificationEmail(data));
  }
}

/** Development stub: prints the verify link instead of sending it. */
export class ConsoleVerificationSender implements VerificationEmailSender {
  async sendVerificationEmail(data: VerificationEmailData): Promise<void> {
    const email = buildVerificationEmail(data);
    console.log(
      `[verify-email:stub] to ${data.to} — subject "${email.subject}" — link: ${buildVerificationLink(data.token)} (expires ${formatHumanDate(data.expiresAt)})`,
    );
  }
}

export interface BuiltPasswordResetEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildPasswordResetEmail(data: PasswordResetEmailData): BuiltPasswordResetEmail {
  const resetLink = `${env.FRONTEND_URL}/#/reset-password?token=${encodeURIComponent(data.token)}`;
  const expiry = formatHumanDate(data.expiresAt);
  const subject = `Reset your ${APP_NAME} password`;
  const text = [
    `We received a request to reset your ${APP_NAME} password.`,
    "",
    `Reset your password: ${resetLink}`,
    "",
    `This link expires on ${expiry} and can only be used once.`,
    "If you didn't request this reset, you can ignore this email.",
  ].join("\n");
  const html = renderEmailLayout({
    title: `Reset your ${APP_NAME} password`,
    body: [
      `<p style="margin:0 0 24px;color:#52525b;">We received a request to reset your password. Use the link below to choose a new one.</p>`,
    ],
    cta: { label: "Reset password", href: resetLink },
    footer: [
      `This link expires on ${expiry} and can only be used once.`,
      `If you didn't request this reset, you can ignore this email.`,
    ],
  });
  return { subject, html, text };
}

export class ResendPasswordResetSender implements PasswordResetEmailSender {
  constructor(
    private readonly client: ResendEmailClient,
    private readonly fromEmail: string,
  ) {}

  async sendPasswordResetEmail(data: PasswordResetEmailData): Promise<void> {
    await sendBuiltEmail(this.client, this.fromEmail, data.to, buildPasswordResetEmail(data));
  }
}

/** Test-only sender that exposes the link in test output, never in production. */
export class ConsolePasswordResetSender implements PasswordResetEmailSender {
  async sendPasswordResetEmail(data: PasswordResetEmailData): Promise<void> {
    const email = buildPasswordResetEmail(data);
    console.log(
      `[password-reset:stub] to ${data.to} — subject "${email.subject}" — link: ${env.FRONTEND_URL}/#/reset-password?token=${data.token} (expires ${formatHumanDate(data.expiresAt)})`,
    );
  }
}

/** Welcome email payload: the freshly-onboarded owner and their store. */
export interface WelcomeEmailData {
  to: string;
  storeName: string;
}

/** Outbound welcome email channel; implemented by the console stub and Resend. */
export interface WelcomeEmailSender {
  sendWelcomeEmail(data: WelcomeEmailData): Promise<void>;
}

export interface BuiltWelcomeEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Builds the HTML + text welcome email, sent right after the store is
 * created at onboarding. The store name is owner-supplied free text, so
 * it is HTML-escaped in the body (it also appears raw in the text part).
 */
export function buildWelcomeEmail(data: WelcomeEmailData): BuiltWelcomeEmail {
  const dashboardUrl = env.FRONTEND_URL;
  const escapedStoreName = escapeHtml(data.storeName);

  const subject = `Welcome to ${APP_NAME} — ${data.storeName} is ready`;

  const text = [
    `Welcome to ${APP_NAME}!`,
    "",
    `Your store, ${data.storeName}, is set up and ready to go.`,
    "",
    `Open your dashboard: ${dashboardUrl}`,
    "",
    "Add products, accept payments, and grow your business from your dashboard.",
  ].join("\n");

  const html = renderEmailLayout({
    title: `Welcome to ${APP_NAME}`,
    body: [
      `<p style="margin:0 0 24px;color:#52525b;">Your store, <strong>${escapedStoreName}</strong>, is set up and ready to go.</p>`,
      `<p style="margin:0 0 24px;color:#52525b;">Add products, accept payments, and grow your business from your dashboard.</p>`,
    ],
    cta: { label: "Open your dashboard", href: dashboardUrl },
    footer: [`You're all set — no further action needed.`],
  });

  return { subject, html, text };
}

export class ResendWelcomeSender implements WelcomeEmailSender {
  constructor(
    private readonly client: ResendEmailClient,
    private readonly fromEmail: string,
  ) {}

  async sendWelcomeEmail(data: WelcomeEmailData): Promise<void> {
    await sendBuiltEmail(this.client, this.fromEmail, data.to, buildWelcomeEmail(data));
  }
}

/** Development stub: prints the dashboard link instead of sending it. */
export class ConsoleWelcomeSender implements WelcomeEmailSender {
  async sendWelcomeEmail(data: WelcomeEmailData): Promise<void> {
    const email = buildWelcomeEmail(data);
    console.log(
      `[welcome-email:stub] to ${data.to} — subject "${email.subject}" — dashboard: ${env.FRONTEND_URL}`,
    );
  }
}
