import { minor, returnMinor, type TestTicket } from "@lsports/contracts";
export const eventKey = (id: string) => id.replace(/^(prematch|inplay):/, "");
export const itemKey = (id: string) => id.split(":").at(-1)!;
export function exposure(
  tickets: TestTicket[],
  exclusiveMarketIds: string[] = ["1", "160"],
) {
  const pending = tickets.filter((t) => t.status === "PENDING");
  let stake = 0n,
    gross = 0n,
    multipleStake = 0n,
    multipleGross = 0n;
  const groups = new Map<
    string,
    {
      eventId: string;
      marketId: string;
      stake: bigint;
      selections: Map<string, { gross: bigint; ticketIds: string[] }>;
      ticketIds: string[];
      exclusive: boolean;
    }
  >();
  for (const ticket of pending) {
    const amount = BigInt(ticket.stakeMinor),
      potential = minor(
        returnMinor(
          amount.toString(),
          ticket.selections.map((s) => s.oddsMicros),
        ),
      );
    stake += amount;
    gross += potential;
    if (ticket.selections.length !== 1) {
      multipleStake += amount;
      multipleGross += potential;
      continue;
    }
    const leg = ticket.selections[0],
      eventId = eventKey(leg.eventId),
      marketId = itemKey(leg.marketId),
      key = JSON.stringify([eventId, marketId]);
    let group = groups.get(key);
    if (!group) {
      group = {
        eventId,
        marketId,
        stake: 0n,
        selections: new Map(),
        ticketIds: [],
        exclusive: exclusiveMarketIds.includes(marketId),
      };
      groups.set(key, group);
    }
    group.stake += amount;
    group.ticketIds.push(ticket.id);
    const selectionId = itemKey(leg.selectionId),
      outcome = group.selections.get(selectionId) || {
        gross: 0n,
        ticketIds: [],
      };
    outcome.gross += potential;
    outcome.ticketIds.push(ticket.id);
    group.selections.set(selectionId, outcome);
  }
  return {
    pendingTickets: pending.length,
    stakeMinor: stake.toString(),
    potentialGrossMinor: gross.toString(),
    conservativeNetLowerBoundMinor: (stake - gross).toString(),
    conservativeLossBoundMinor: (gross > stake ? gross - stake : 0n).toString(),
    methodology: "conservative_all_pending_win_bound",
    simpleMarkets: [...groups.values()].map((group) => ({
      eventId: group.eventId,
      marketId: group.marketId,
      stakeMinor: group.stake.toString(),
      exactWithinDeclaredExclusiveMarket: group.exclusive,
      assumption: group.exclusive
        ? "Resultados mutuamente excluyentes declarados; sin modelar dead heat ni correlaciones entre mercados."
        : "Exclusividad no confirmada: solo cotas conservadoras, no pérdida exacta.",
      scenarios: group.exclusive
        ? [
            ...[...group.selections].map(([selectionId, result]) => ({
              selectionId,
              potentialGrossMinor: result.gross.toString(),
              netResultMinor: (group.stake - result.gross).toString(),
              ticketIds: result.ticketIds,
            })),
            {
              selectionId: "other_unlisted_outcome",
              potentialGrossMinor: "0",
              netResultMinor: group.stake.toString(),
              ticketIds: [],
            },
            {
              selectionId: "all_void_refund",
              potentialGrossMinor: group.stake.toString(),
              netResultMinor: "0",
              ticketIds: group.ticketIds,
            },
          ]
        : [],
      ticketIds: group.ticketIds,
    })),
    multiples: {
      tickets: pending.filter((t) => t.selections.length > 1).length,
      stakeMinor: multipleStake.toString(),
      potentialGrossBoundMinor: multipleGross.toString(),
      netLowerBoundMinor: (multipleStake - multipleGross).toString(),
      methodology: "all_legs_win_conservative_bound_not_exact_loss",
    },
  };
}
