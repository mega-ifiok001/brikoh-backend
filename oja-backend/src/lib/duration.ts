/**
 * Parses a duration string ("30s", "15m", "24h", "7d") into milliseconds.
 * Throws on anything else — the env schema validates durations at boot,
 * so a failure here is a programming error, not user input.
 */
export function parseDurationToMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (match === null) {
    throw new Error(`Invalid duration: "${value}" (expected e.g. 30s, 15m, 24h, 7d)`);
  }
  // The regex guarantees both groups exist (noUncheckedIndexedAccess).
  const amount = Number(match[1]!);
  const unit = match[2]!;
  const multipliers: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const multiplier = multipliers[unit];
  if (multiplier === undefined) {
    throw new Error(`Invalid duration: "${value}" (expected e.g. 30s, 15m, 24h, 7d)`);
  }
  return amount * multiplier;
}
