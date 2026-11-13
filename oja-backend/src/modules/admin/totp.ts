import { generateSecret, generateSync, generateURI, verifySync } from "otplib";

/**
 * TOTP (RFC 6238) helpers wrapping otplib v12 with a fixed policy: 30s
 * period, 6 digits, ±1 step acceptance window (epochTolerance = 30s). The
 * secret is stored per admin (AdminUser.twoFactorSecret) and every admin
 * login requires the current code — there is no 2FA-less session.
 *
 * otplib v12 notes: the period option is `period` (not `step`) and the
 * epoch is Unix TIME IN SECONDS (not milliseconds).
 */

const TOTP_POLICY = { period: 30, digits: 6, epochTolerance: 30 } as const;

function epochSeconds(at?: number | Date): number {
  const ms = at instanceof Date ? at.getTime() : (at ?? Date.now());
  return Math.floor(ms / 1000);
}

/** Fresh 32-byte base32 secret. */
export function generateTotpSecret(): string {
  return generateSecret();
}

/** 6-digit code for a secret at a given time (defaults to now). */
export function generateTotpToken(secret: string, at?: number | Date): string {
  return generateSync({
    secret,
    period: TOTP_POLICY.period,
    digits: TOTP_POLICY.digits,
    epoch: epochSeconds(at),
  });
}

/**
 * Verifies a 6-digit code against the secret within the ±1 step window.
 * Rejects malformed secrets and non-numeric tokens with false — never
 * throws.
 */
export function verifyTotpToken(secret: string, token: string, at?: number | Date): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  if (!/^[A-Z2-7]+={0,3}$/.test(secret)) return false;
  try {
    return verifySync({
      token,
      secret,
      period: TOTP_POLICY.period,
      digits: TOTP_POLICY.digits,
      epochTolerance: TOTP_POLICY.epochTolerance,
      epoch: epochSeconds(at),
    }).valid;
  } catch {
    return false;
  }
}

/** otpauth:// provisioning URL for Authenticator apps (label is RFC-PERCENT-ENCODED). */
export function buildTotpOtpauthUrl(secret: string, email: string): string {
  return generateURI({
    issuer: "Brikoh Admin",
    label: email,
    secret,
    period: TOTP_POLICY.period,
    digits: TOTP_POLICY.digits,
  });
}
