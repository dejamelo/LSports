import { minor, MoneyError } from "@lsports/contracts";
export interface BetLimits {
  minStakeMinor: string;
  maxStakeMinor: string;
  maxReturnMinor: string;
  allowRepeatedTickets: boolean;
  maxTicketsPerPlayerEvent: number | null;
  maxStakePerPlayerEventMinor: string | null;
  sameEventMultiples: "blocked";
}
export interface LimitPolicy extends BetLimits {
  clientMayEdit: boolean;
  revision: number;
}
export const defaultLimits: BetLimits = {
  minStakeMinor: "1",
  maxStakeMinor: "100000000",
  maxReturnMinor: "9007199254740991",
  allowRepeatedTickets: true,
  maxTicketsPerPlayerEvent: null,
  maxStakePerPlayerEventMinor: null,
  sameEventMultiples: "blocked",
};
export function validateLimits(value: unknown): BetLimits {
  const input = value as BetLimits;
  if (!input || typeof input !== "object")
    throw new MoneyError(
      "INVALID_LIMITS",
      "Configuración de límites inválida.",
    );
  const low = minor(input.minStakeMinor),
    high = minor(input.maxStakeMinor),
    returns = minor(input.maxReturnMinor);
  if (
    low < 1n ||
    high < low ||
    high > 100000000n ||
    returns < 1n ||
    returns > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new MoneyError(
      "INVALID_LIMITS",
      "Revisá mínimo, máximo y retorno permitido.",
    );
  if (typeof input.allowRepeatedTickets !== "boolean")
    throw new MoneyError(
      "INVALID_LIMITS",
      "Definí si se permiten billetes repetidos por evento.",
    );
  if (
    input.maxTicketsPerPlayerEvent !== null &&
    (!Number.isSafeInteger(input.maxTicketsPerPlayerEvent) ||
      input.maxTicketsPerPlayerEvent < 1 ||
      input.maxTicketsPerPlayerEvent > 1000000)
  )
    throw new MoneyError(
      "INVALID_LIMITS",
      "La cantidad máxima debe ser un entero positivo o null.",
    );
  if (
    input.maxStakePerPlayerEventMinor !== null &&
    minor(input.maxStakePerPlayerEventMinor) < 1n
  )
    throw new MoneyError(
      "INVALID_LIMITS",
      "El acumulado máximo debe ser positivo o null.",
    );
  if (input.sameEventMultiples !== "blocked")
    throw new MoneyError(
      "CORRELATED_SELECTIONS_UNSUPPORTED",
      "Las selecciones correlacionadas del mismo evento siguen bloqueadas.",
    );
  return {
    minStakeMinor: low.toString(),
    maxStakeMinor: high.toString(),
    maxReturnMinor: returns.toString(),
    allowRepeatedTickets: input.allowRepeatedTickets,
    maxTicketsPerPlayerEvent: input.maxTicketsPerPlayerEvent,
    maxStakePerPlayerEventMinor: input.maxStakePerPlayerEventMinor,
    sameEventMultiples: "blocked",
  };
}
const min = (a: string, b: string) => (minor(a) < minor(b) ? a : b);
export function effectiveLimits(
  own: BetLimits,
  policy: LimitPolicy,
): BetLimits {
  const low =
    minor(own.minStakeMinor) > minor(policy.minStakeMinor)
      ? own.minStakeMinor
      : policy.minStakeMinor;
  const count =
    own.maxTicketsPerPlayerEvent === null
      ? policy.maxTicketsPerPlayerEvent
      : policy.maxTicketsPerPlayerEvent === null
        ? own.maxTicketsPerPlayerEvent
        : Math.min(
            own.maxTicketsPerPlayerEvent,
            policy.maxTicketsPerPlayerEvent,
          );
  const accumulated =
    own.maxStakePerPlayerEventMinor === null
      ? policy.maxStakePerPlayerEventMinor
      : policy.maxStakePerPlayerEventMinor === null
        ? own.maxStakePerPlayerEventMinor
        : min(
            own.maxStakePerPlayerEventMinor,
            policy.maxStakePerPlayerEventMinor,
          );
  return {
    minStakeMinor: low,
    maxStakeMinor: min(own.maxStakeMinor, policy.maxStakeMinor),
    maxReturnMinor: min(own.maxReturnMinor, policy.maxReturnMinor),
    allowRepeatedTickets:
      own.allowRepeatedTickets && policy.allowRepeatedTickets,
    maxTicketsPerPlayerEvent: count,
    maxStakePerPlayerEventMinor: accumulated,
    sameEventMultiples: "blocked",
  };
}
export function withinPolicy(limits: BetLimits, policy: LimitPolicy) {
  return (
    JSON.stringify(effectiveLimits(limits, policy)) === JSON.stringify(limits)
  );
}
