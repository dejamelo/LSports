export const currencyPrecision = {
  ARS: 2,
  CLP: 0,
  PYG: 0,
  USD: 2,
  VES: 2,
} as const;
export type Currency = keyof typeof currencyPrecision;
export type IntegrationChannel = "web" | "mobile" | "pos";
export interface OperationScope {
  clientId: string;
  operationId: string;
  currency: Currency;
}
export interface WalletScope extends OperationScope {
  playerId: string;
}
// Internal transaction context, not an agreed external casino HTTP protocol.
export interface WalletTransactionScope extends WalletScope {
  transactionId: string;
  idempotencyKey: string;
  amountMinor: string;
}
export class MoneyError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function currency(value: unknown): Currency {
  if (typeof value !== "string" || !Object.hasOwn(currencyPrecision, value))
    throw new MoneyError(
      "INVALID_CURRENCY",
      "Moneda no admitida. Usá ARS, CLP, PYG, USD o VES.",
    );
  return value as Currency;
}
export function minor(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,29})$/.test(value))
    throw new MoneyError(
      "INVALID_MINOR_AMOUNT",
      "El importe debe ser un entero decimal en unidades menores, enviado como texto.",
    );
  return BigInt(value);
}
export function majorToMinor(value: string, code: Currency): string {
  const digits = currencyPrecision[code];
  const match = /^(0|[1-9]\d{0,20})(?:[.,](\d+))?$/.exec(value.trim());
  if (!match || (match[2]?.length || 0) > digits)
    throw new MoneyError(
      "INVALID_PRECISION",
      `${code} admite ${digits} decimales, sin separadores de miles.`,
    );
  return (
    BigInt(match[1]) * 10n ** BigInt(digits) +
    BigInt((match[2] || "").padEnd(digits, "0") || "0")
  ).toString();
}
export function formatMinor(value: string, code: Currency): string {
  const amount = minor(value),
    digits = currencyPrecision[code],
    scale = 10n ** BigInt(digits);
  return `${(amount / scale).toLocaleString("es-AR")}${digits ? "," + (amount % scale).toString().padStart(digits, "0") : ""} ${code}`;
}
export function returnMinor(
  stake: string,
  oddsMicros: readonly number[],
): string {
  let numerator = minor(stake),
    denominator = 1n;
  for (const odd of oddsMicros) {
    if (!Number.isSafeInteger(odd) || odd < 1000000)
      throw new MoneyError("INVALID_ODDS", "Cuota fija inválida.");
    numerator *= BigInt(odd);
    denominator *= 1000000n;
  }
  return ((numerator + denominator / 2n) / denominator).toString();
}
