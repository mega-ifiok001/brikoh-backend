import type { OtpPurpose } from "./service.js";

interface TestOtpMessage {
  purpose: OtpPurpose;
  code: string;
  expiresAt: Date;
}

const messages = new Map<string, TestOtpMessage[]>();

/** In-memory mail sink for integration tests; OTP values are never printed or persisted. */
export function recordTestOtp(email: string, message: TestOtpMessage): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Test OTP outbox is only available in tests");
  const queue = messages.get(email) ?? [];
  queue.push(message);
  messages.set(email, queue);
}

export function takeTestOtp(email: string, purpose: OtpPurpose): TestOtpMessage | undefined {
  if (process.env.NODE_ENV !== "test") throw new Error("Test OTP outbox is only available in tests");
  const queue = messages.get(email) ?? [];
  let index = queue.length - 1;
  while (index >= 0 && queue[index]!.purpose !== purpose) index -= 1;
  if (index < 0) return undefined;
  const [message] = queue.splice(index, 1);
  if (queue.length === 0) messages.delete(email);
  else messages.set(email, queue);
  return message;
}

export function clearTestOtpOutbox(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Test OTP outbox is only available in tests");
  messages.clear();
}
