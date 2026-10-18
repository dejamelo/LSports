// LSports ticket #217525, Szymon Luka, confirmed by customer 2026-10-18:
// HTTP and AMQP wall-clock timestamps without offsets are UTC.
const pattern =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/i;
export function providerTimestamp(raw: unknown):
  | {
      milliseconds: number;
      order: string;
      utcInput: string;
      timezone: "explicit" | "absent" | "epoch_milliseconds";
    }
  | undefined {
  if (
    typeof raw === "number" &&
    Number.isSafeInteger(raw) &&
    Math.abs(raw) <= 8640000000000000
  )
    return {
      milliseconds: raw,
      order: (BigInt(raw) * 1000000n).toString(),
      utcInput: new Date(raw).toISOString(),
      timezone: "epoch_milliseconds",
    };
  if (typeof raw !== "string") return;
  const m = pattern.exec(raw);
  if (!m) return;
  const [, year, month, day, hour, minute, second, fraction = "", offset] = m;
  const y = Number(year),
    mo = Number(month),
    d = Number(day),
    h = Number(hour),
    mi = Number(minute),
    se = Number(second);
  const calendar = new Date(0);
  calendar.setUTCFullYear(y, mo - 1, d);
  calendar.setUTCHours(h, mi, se, 0);
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    h > 23 ||
    mi > 59 ||
    se > 59 ||
    calendar.getUTCFullYear() !== y ||
    calendar.getUTCMonth() !== mo - 1 ||
    calendar.getUTCDate() !== d
  )
    return;
  if (
    offset &&
    offset.toUpperCase() !== "Z" &&
    (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)
  )
    return;
  const utcInput = raw.replace(" ", "T") + (offset ? "" : "Z");
  const milliseconds = Date.parse(utcInput);
  if (!Number.isFinite(milliseconds)) return;
  // Date/SDK truncate below milliseconds; retain nanoseconds as an integer string.
  const ns = BigInt(fraction.padEnd(9, "0") || "0") % 1000000n;
  return {
    milliseconds,
    order: (BigInt(milliseconds) * 1000000n + ns).toString(),
    utcInput,
    timezone: offset ? "explicit" : "absent",
  };
}
export function normalizeSdkTimestamps(value: unknown): any {
  if (Array.isArray(value)) return value.map(normalizeSdkTimestamps);
  if (!value || typeof value !== "object" || value instanceof Date)
    return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      [
        "LastUpdate",
        "CreationDate",
        "StartDate",
        "StartTime",
        "EndDate",
        "NextFixtureStartTime",
        "ServerTimestamp",
        "lastUpdate",
        "BirthDate",
      ].includes(key) && typeof v === "string"
        ? providerTimestamp(v)?.utcInput || v
        : normalizeSdkTimestamps(v),
    ]),
  );
}
const preciseDates = new WeakMap<Date, string>();
export function attachTimestampPrecision(raw: any, sdk: any): void {
  if (!raw || !sdk || typeof raw !== "object" || typeof sdk !== "object")
    return;
  if (Array.isArray(raw) && Array.isArray(sdk)) {
    raw.forEach((r, i) => attachTimestampPrecision(r, sdk[i]));
    return;
  }
  for (const [key, v] of Object.entries(raw)) {
    const parsed = sdk[key[0].toLowerCase() + key.slice(1)];
    if (parsed instanceof Date) {
      const proof = providerTimestamp(v);
      if (proof && parsed.getTime() === proof.milliseconds)
        preciseDates.set(parsed, proof.order);
    } else attachTimestampPrecision(v, parsed);
  }
}
export const timestampOrder = (date: unknown, fallback: number): string =>
  date instanceof Date && preciseDates.has(date)
    ? preciseDates.get(date)!
    : (
        BigInt(
          Math.trunc(
            date instanceof Date && Number.isFinite(date.getTime())
              ? date.getTime()
              : fallback,
          ),
        ) * 1000000n
      ).toString();

export function hasInvalidProviderTimestamp(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasInvalidProviderTimestamp);
  if (!value || typeof value !== "object" || value instanceof Date)
    return false;
  return Object.entries(value).some(([key, v]) =>
    (key === "LastUpdate" || key === "lastUpdate") && v != null
      ? !providerTimestamp(v)
      : hasInvalidProviderTimestamp(v),
  );
}
