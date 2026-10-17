import { useState } from "react";
import type { SportEvent, Selection } from "@lsports/contracts";
export function EventMarkets({
  event,
  selected,
  onSelect,
  blocked,
}: {
  event: SportEvent;
  selected: string[];
  onSelect: (event: SportEvent, selection: Selection) => void;
  blocked: boolean;
}) {
  const [marketId, setMarketId] = useState("");
  const markets = event.markets || [
    { id: "demo", name: event.market, selections: event.selections },
  ];
  const market = markets.find((m) => m.id === marketId) || markets[0];
  return (
    <div className="markets">
      {markets.length > 1 ? (
        <select
          aria-label={`Mercado de ${event.home}`}
          value={market?.id || ""}
          onChange={(e) => setMarketId(e.target.value)}
        >
          {markets.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.status !== undefined && m.status !== 1
                ? " · No disponible"
                : ""}
            </option>
          ))}
        </select>
      ) : (
        <span>{market?.name || "Sin mercados disponibles"}</span>
      )}
      <div className="odds-row">
        {market?.selections.map((selection) => (
          <button
            disabled={blocked || selection.available === false}
            title={
              selection.available === false
                ? "Cuota suspendida o no disponible"
                : selection.label
            }
            aria-pressed={selected.includes(selection.id)}
            className={selected.includes(selection.id) ? "picked" : ""}
            key={selection.id}
            onClick={() =>
              onSelect({ ...event, market: market.name }, selection)
            }
          >
            <span>{selection.label}</span>
            <strong>
              {selection.available === false ? "—" : selection.odds.toFixed(2)}
            </strong>
          </button>
        ))}
      </div>
      {!market?.selections.length && (
        <p className="market-empty">Sin cuotas disponibles</p>
      )}
    </div>
  );
}
