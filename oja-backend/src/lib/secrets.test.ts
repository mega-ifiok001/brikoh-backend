import { describe, expect, it } from "vitest";
import { createSecretCipher, decryptSecret, encryptSecret } from "./secrets.js";

const SECRET = "sk_live_0123456789abcdef0123456789abcdef";

describe("encryptSecret / decryptSecret (unit)", () => {
  it("round-trips a secret through AES-256-GCM", () => {
    const payload = encryptSecret(SECRET);

    expect(payload).not.toContain(SECRET);
    expect(decryptSecret(payload)).toBe(SECRET);
  });

  it("produces the v1:iv:tag:ciphertext envelope with base64 parts", () => {
    const payload = encryptSecret(SECRET);

    const parts = payload.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toMatch(/^[A-Za-z0-9+/=]+$/); // iv
    expect(parts[2]).toMatch(/^[A-Za-z0-9+/=]+$/); // auth tag
    expect(parts[3]).toMatch(/^[A-Za-z0-9+/=]+$/); // ciphertext
  });

  it("uses a fresh random IV every time (same plaintext, different payloads)", () => {
    const first = encryptSecret(SECRET);
    const second = encryptSecret(SECRET);

    expect(first).not.toBe(second);
  });

  it("rejects a tampered ciphertext", () => {
    const payload = encryptSecret(SECRET);
    const [version, iv, tag, ciphertext] = payload.split(":");
    const flipped = ciphertext!.endsWith("=")
      ? `${ciphertext!.slice(0, -2)}xx`
      : `${ciphertext!.slice(0, -1)}${ciphertext!.endsWith("a") ? "b" : "a"}`;

    expect(() => decryptSecret([version, iv, tag, flipped].join(":"))).toThrow();
  });

  it("rejects a payload encrypted with a different key", () => {
    const other = createSecretCipher(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    const foreignPayload = other.encrypt(SECRET);

    expect(() => decryptSecret(foreignPayload)).toThrow();
  });

  it("rejects an unknown envelope version", () => {
    const payload = encryptSecret(SECRET);
    const parts = payload.split(":");

    expect(() => decryptSecret(["v9", ...parts.slice(1)].join(":"))).toThrow(/version/i);
  });

  it("rejects a malformed envelope", () => {
    expect(() => decryptSecret("not-an-envelope")).toThrow();
    expect(() => decryptSecret("v1:only")).toThrow();
  });
});
