import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
/**
 * AES-256-GCM encryption for merchant payment credentials at rest.
 *
 * The master key is PAYMENT_ENCRYPTION_KEY (64 hex chars, validated at
 * boot by the env schema) and NEVER leaves the backend. Each encryption
 * draws a fresh random 12-byte IV; the auth tag authenticates both the
 * ciphertext and the IV, so any tampering (or a wrong key) fails loudly
 * at decrypt time instead of producing garbage.
 *
 * The on-disk envelope is `v1:<iv>:<authTag>:<ciphertext>`, all base64:
 * the version prefix allows future algorithm changes to coexist with
 * legacy rows. The plaintext never appears in the envelope and the key
 * is never stored next to the data.
 */
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
/** Master key bytes from the validated environment (hex -> 32 bytes). */
function envKeyBytes() {
    return Buffer.from(env.PAYMENT_ENCRYPTION_KEY, "hex");
}
/**
 * Cipher bound to an explicit key — used by callers who hold a key other
 * than the platform one (rotation tooling, tests).
 */
export function createSecretCipher(keyHex) {
    const key = Buffer.from(keyHex, "hex");
    if (key.length !== 32) {
        throw new Error("encryption key must be 32 bytes");
    }
    return {
        encrypt(plaintext) {
            const iv = randomBytes(IV_LENGTH);
            const cipher = createCipheriv(ALGORITHM, key, iv);
            const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
            const tag = cipher.getAuthTag();
            return [
                VERSION,
                iv.toString("base64"),
                tag.toString("base64"),
                ciphertext.toString("base64"),
            ].join(":");
        },
        decrypt(payload) {
            const parts = payload.split(":");
            if (parts.length !== 4 || parts[0] !== VERSION) {
                throw new Error(`unsupported secret envelope (version ${parts[0] ?? "unknown"})`);
            }
            const ivB64 = parts[1];
            const tagB64 = parts[2];
            const ciphertextB64 = parts[3];
            const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
            decipher.setAuthTag(Buffer.from(tagB64, "base64"));
            const plaintext = Buffer.concat([
                decipher.update(Buffer.from(ciphertextB64, "base64")),
                decipher.final(),
            ]);
            return plaintext.toString("utf8");
        },
    };
}
const platformCipher = createSecretCipher(envKeyBytes().toString("hex"));
/** Encrypts a secret with the platform master key. */
export function encryptSecret(plaintext) {
    return platformCipher.encrypt(plaintext);
}
/** Decrypts a platform-encrypted secret; throws on tamper or wrong key. */
export function decryptSecret(payload) {
    return platformCipher.decrypt(payload);
}
//# sourceMappingURL=secrets.js.map