import { beforeEach, describe, expect, it, vi } from "vitest";

const resendMocks = vi.hoisted(() => ({ Resend: vi.fn() }));
vi.mock("resend", () => ({ Resend: resendMocks.Resend }));

import { env } from "../../config/env.js";
import type { VerificationEmailData } from "./service.js";
import {
  buildVerificationEmail,
  buildWelcomeEmail,
  ConsoleVerificationSender,
  ConsoleWelcomeSender,
  createResendClient,
  ResendVerificationSender,
  ResendWelcomeSender,
} from "./email.js";

const EMAIL_DATA: VerificationEmailData = {
  to: "owner@example.com",
  token: "vrf_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO123456",
  expiresAt: new Date("2026-08-10T12:00:00Z"),
};

describe("buildVerificationEmail (unit)", () => {
  it("builds an HTML+text verification email with CTA link and readable expiry", () => {
    const email = buildVerificationEmail(EMAIL_DATA);

    expect(email.subject).toContain("Brikoh");

    expect(email.html).toContain(`href="${env.FRONTEND_URL}/#/verify?token=${EMAIL_DATA.token}"`);
    expect(email.html).toContain("Monday, August 10, 2026");

    expect(email.text).toContain(`${env.FRONTEND_URL}/#/verify?token=${EMAIL_DATA.token}`);
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
        html: expect.stringContaining(`/verify?token=${EMAIL_DATA.token}`),
        text: expect.stringContaining(env.FRONTEND_URL),
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
  it("logs the verify link and expiry for development", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await new ConsoleVerificationSender().sendVerificationEmail(EMAIL_DATA);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${env.FRONTEND_URL}/#/verify?token=${EMAIL_DATA.token}`),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Monday, August 10, 2026"));
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
