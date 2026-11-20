import { beforeEach, describe, expect, it, vi } from "vitest";

const resendMocks = vi.hoisted(() => ({ Resend: vi.fn() }));
vi.mock("resend", () => ({ Resend: resendMocks.Resend }));

import { env } from "../../config/env.js";
import type { PasswordResetEmailData, VerificationEmailData } from "./service.js";
import { clearTestOtpOutbox, takeTestOtp } from "./testOtpOutbox.js";
import {
  buildVerificationEmail,
  buildPasswordResetEmail,
  buildWelcomeEmail,
  ConsoleVerificationSender,
  ConsoleWelcomeSender,
  createResendClient,
  ResendVerificationSender,
  ResendWelcomeSender,
} from "./email.js";

const EMAIL_DATA: VerificationEmailData = {
  to: "owner@example.com",
  code: "042817",
  expiresAt: new Date("2026-08-10T12:00:00Z"),
};

const RESET_EMAIL_DATA: PasswordResetEmailData = {
  to: "owner@example.com",
  code: "681204",
  expiresAt: new Date("2026-08-10T12:10:00Z"),
};

describe("buildVerificationEmail (unit)", () => {
  it("builds an HTML+text verification email with a code and readable expiry", () => {
    const email = buildVerificationEmail(EMAIL_DATA);

    expect(email.subject).toContain("Brikoh");
    expect(email.html).toContain(EMAIL_DATA.code);
    expect(email.text).toContain(EMAIL_DATA.code);
    expect(email.html).not.toContain("/verify-email");
    expect(email.text).not.toContain("/verify-email");
    expect(email.html).toContain("Monday, August 10, 2026");
    expect(email.text).toContain("Monday, August 10, 2026");
  });

  it("never shows the raw UTC expiry string (edge)", () => {
    const email = buildVerificationEmail(EMAIL_DATA);

    expect(email.html).not.toContain("2026-08-10T12:00:00Z");
    expect(email.text).not.toContain("2026-08-10T12:00:00Z");
  });
});

describe("createResendClient (unit)", () => {
  it("constructs the Resend SDK client with the API key", () => {
    resendMocks.Resend.mockImplementation(function (apiKey: string) {
      return { apiKey, emails: { send: vi.fn() } };
    });

    const client = createResendClient("re_key");

    expect(resendMocks.Resend).toHaveBeenCalledWith("re_key");
    expect(client.emails.send).toBeDefined();
  });
});

describe("ResendVerificationSender (unit)", () => {
  const emails = { send: vi.fn() };
  let sender: ResendVerificationSender;

  beforeEach(() => {
    emails.send.mockReset();
    sender = new ResendVerificationSender({ emails } as never, "verify@example.com");
  });

  it("sends the built email through the Resend client (happy path)", async () => {
    emails.send.mockResolvedValue({ id: "email-1" });

    await sender.sendVerificationEmail(EMAIL_DATA);

    expect(emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "verify@example.com",
        to: EMAIL_DATA.to,
        subject: expect.stringContaining("Brikoh"),
        html: expect.stringContaining(EMAIL_DATA.code),
        text: expect.stringContaining(EMAIL_DATA.code),
      }),
    );
  });

  it("propagates a Resend API failure so the caller can log it (sad path)", async () => {
    emails.send.mockRejectedValue(new Error("resend 429 rate limited"));

    await expect(sender.sendVerificationEmail(EMAIL_DATA)).rejects.toThrow(
      "resend 429 rate limited",
    );
  });
});

describe("ConsoleVerificationSender (unit)", () => {
  it("captures the OTP in the test outbox without logging it", async () => {
    clearTestOtpOutbox();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await new ConsoleVerificationSender().sendVerificationEmail(EMAIL_DATA);

    expect(takeTestOtp(EMAIL_DATA.to, "EMAIL_VERIFICATION")?.code).toBe(EMAIL_DATA.code);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("buildPasswordResetEmail (unit)", () => {
  it("contains the reset OTP and no reset URL", () => {
    const email = buildPasswordResetEmail(RESET_EMAIL_DATA);
    expect(email.html).toContain(RESET_EMAIL_DATA.code);
    expect(email.text).toContain(RESET_EMAIL_DATA.code);
    expect(email.html).not.toContain("reset-password?");
    expect(email.text).not.toContain("reset-password?");
  });
});

const WELCOME_DATA = {
  to: "owner@example.com",
  storeName: "Ade's Corner Store",
};

describe("buildWelcomeEmail (unit)", () => {
  it("builds an HTML+text welcome email with dashboard CTA and escaped store name", () => {
    const email = buildWelcomeEmail(WELCOME_DATA);

    expect(email.subject).toContain("Brikoh");
    expect(email.subject).toContain("Ade's Corner Store");

    expect(email.html).toContain(`href="${env.FRONTEND_URL}"`);
    expect(email.html).toContain("Ade&#39;s Corner Store");
    expect(email.html).toContain("Welcome to Brikoh");

    expect(email.text).toContain("Ade's Corner Store");
    expect(email.text).toContain(env.FRONTEND_URL);
  });

  it("escapes HTML supplied through the store name (edge)", () => {
    const email = buildWelcomeEmail({ ...WELCOME_DATA, storeName: "<b>Ade's</b>" });

    expect(email.html).not.toContain("<b>Ade's</b>");
    expect(email.html).toContain("&lt;b&gt;Ade&#39;s&lt;/b&gt;");
  });
});

describe("ResendWelcomeSender (unit)", () => {
  const emails = { send: vi.fn() };
  let sender: ResendWelcomeSender;

  beforeEach(() => {
    emails.send.mockReset();
    sender = new ResendWelcomeSender({ emails } as never, "verify@example.com");
  });

  it("sends the built email through the Resend client (happy path)", async () => {
    emails.send.mockResolvedValue({ id: "email-2" });

    await sender.sendWelcomeEmail(WELCOME_DATA);

    expect(emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "verify@example.com",
        to: WELCOME_DATA.to,
        subject: expect.stringContaining("Brikoh"),
        html: expect.stringContaining(env.FRONTEND_URL),
        text: expect.stringContaining(env.FRONTEND_URL),
      }),
    );
  });

  it("propagates a Resend API failure so the caller can log it (sad path)", async () => {
    emails.send.mockRejectedValue(new Error("resend 429 rate limited"));

    await expect(sender.sendWelcomeEmail(WELCOME_DATA)).rejects.toThrow("resend 429 rate limited");
  });
});

describe("ConsoleWelcomeSender (unit)", () => {
  it("logs the dashboard link for development", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await new ConsoleWelcomeSender().sendWelcomeEmail(WELCOME_DATA);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(env.FRONTEND_URL));
  });
});
