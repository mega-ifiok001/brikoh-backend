import { beforeEach, describe, expect, it, vi } from "vitest";

const resendMocks = vi.hoisted(() => ({ Resend: vi.fn() }));
vi.mock("resend", () => ({ Resend: resendMocks.Resend }));

import { env } from "../../config/env.js";
import type { InviteEmailData } from "./invite.service.js";
import {
  buildInviteEmail,
  ConsoleInviteSender,
  createResendClient,
  ResendInviteSender,
} from "./email.js";

const EMAIL_DATA: InviteEmailData = {
  to: "hire@example.com",
  storeName: "Ade's Corner Store",
  inviterEmail: "owner@example.com",
  token: "inv_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO123456",
  expiresAt: new Date("2026-08-10T12:00:00Z"),
};

describe("buildInviteEmail (unit)", () => {
  it("builds an HTML+text invite with store, inviter, CTA link, and readable expiry", () => {
    const email = buildInviteEmail(EMAIL_DATA);

    expect(email.subject).toContain("Ade's Corner Store");
    expect(email.subject).toContain("Brikoh");

    expect(email.html).toContain("Ade&#39;s Corner Store");
    expect(email.html).toContain("owner@example.com");
    expect(email.html).toContain(
      `href="${env.FRONTEND_URL}/#/accept-invite?token=${EMAIL_DATA.token}"`,
    );
    expect(email.html).toContain("Monday, August 10, 2026");

    expect(email.text).toContain("Ade's Corner Store");

    expect(email.text).toContain(`${env.FRONTEND_URL}/#/accept-invite?token=${EMAIL_DATA.token}`);
    expect(email.text).toContain("Monday, August 10, 2026");
  });

  it("never shows the raw UTC expiry string (edge)", () => {
    const email = buildInviteEmail(EMAIL_DATA);

    expect(email.html).not.toContain("2026-08-10T12:00:00Z");
    expect(email.text).not.toContain("2026-08-10T12:00:00Z");
  });

  it("escapes store names that contain HTML (edge)", () => {
    const email = buildInviteEmail({ ...EMAIL_DATA, storeName: "<b>Ade's</b>" });

    expect(email.html).not.toContain("<b>Ade's</b>");
    expect(email.html).toContain("&lt;b&gt;Ade&#39;s&lt;/b&gt;");
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

describe("ResendInviteSender (unit)", () => {
  const emails = { send: vi.fn() };
  let sender: ResendInviteSender;

  beforeEach(() => {
    emails.send.mockReset();
    sender = new ResendInviteSender({ emails } as never, "invites@example.com");
  });

  it("sends the built email through the Resend client (happy path)", async () => {
    emails.send.mockResolvedValue({ id: "email-1" });

    await sender.sendInviteEmail(EMAIL_DATA);

    expect(emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "invites@example.com",
        to: EMAIL_DATA.to,
        subject: expect.stringContaining("Ade's Corner Store"),
        html: expect.stringContaining(`/#/accept-invite?token=${EMAIL_DATA.token}`),
        text: expect.stringContaining(env.FRONTEND_URL),
      }),
    );
  });

  it("propagates a Resend API failure so the caller can log it (sad path)", async () => {
    emails.send.mockRejectedValue(new Error("resend 429 rate limited"));

    await expect(sender.sendInviteEmail(EMAIL_DATA)).rejects.toThrow("resend 429 rate limited");
  });
});

describe("ConsoleInviteSender (unit)", () => {
  it("logs the accept link and expiry for development", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await new ConsoleInviteSender().sendInviteEmail(EMAIL_DATA);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${env.FRONTEND_URL}/#/accept-invite?token=${EMAIL_DATA.token}`),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Monday, August 10, 2026"));
  });
});
