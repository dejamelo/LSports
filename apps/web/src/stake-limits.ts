import {
  currencyPrecision,
  minor,
  returnMinor,
  type Currency,
} from "@lsports/contracts";
export interface StakeLimits {
  minStakeMinor: string;
  maxStakeMinor: string;
  maxReturnMinor: string;
  allowRepeatedTickets: boolean;
  maxTicketsPerPlayerEvent: number | null;
  maxStakePerPlayerEventMinor: string | null;
  sameEventMultiples: "blocked";
}
export function minorInput(value: string, code: Currency): string {
  const n = minor(value),
    digits = currencyPrecision[code],
    scale = 10n ** BigInt(digits);
  return `${n / scale}${digits ? "." + (n % scale).toString().padStart(digits, "0") : ""}`;
}
// Suggestions only. Server checks current scope, prices, player history and reserves atomically.
export function stakeShortcuts(
  limits: StakeLimits,
  oddsMicros: readonly number[],
): string[] {
  if (oddsMicros.some((odd) => !Number.isSafeInteger(odd) || odd < 1000000))
    return [];
  const low = minor(limits.minStakeMinor);
  let high = minor(limits.maxStakeMinor);
  if (low < 1n || high < low) return [];
  if (oddsMicros.length) {
    let left = 0n,
      right = high;
    while (left < right) {
      const mid = (left + right + 1n) / 2n;
      if (
        minor(returnMinor(mid.toString(), oddsMicros)) <=
        minor(limits.maxReturnMinor)
      )
        left = mid;
      else right = mid - 1n;
    }
    high = left;
  }
  if (high < low) return [];
  return [
    ...new Set(
      [low, low * 10n, low * 50n].map((v) => (v > high ? high : v).toString()),
    ),
  ];
}
