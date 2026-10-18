import { PlatformError } from "@lsports/feed-store/platform";
// Internal boundary only. This is NOT a proposed casino wallet HTTP contract.
// An external adapter must be designed with the casino before money is enabled.
export interface WalletReadiness {
  mode: "simulation";
  externalContractDefined: false;
  operations: Record<
    "balance" | "debit" | "credit" | "reversal" | "reconciliation",
    "not_connected"
  >;
}
export const walletReadiness: WalletReadiness = Object.freeze({
  mode: "simulation",
  externalContractDefined: false,
  operations: {
    balance: "not_connected",
    debit: "not_connected",
    credit: "not_connected",
    reversal: "not_connected",
    reconciliation: "not_connected",
  },
} as const);
export function assertSimulation(input: Record<string, unknown>) {
  if (input.financialMode !== undefined && input.financialMode !== "simulation")
    throw new PlatformError(
      "REAL_MONEY_DISABLED",
      "Solo se admiten operaciones simuladas. El contrato de cartera está pendiente.",
      409,
    );
}
