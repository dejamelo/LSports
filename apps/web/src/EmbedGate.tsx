import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { setEmbedAccess, setEmbedContext } from "./sportsbook-api";
// One exchange even with React StrictMode; the single-use code is removed from
// browser history immediately and the scoped access token stays in memory only.
let exchange: Promise<void> | undefined;
function startExchange() {
  if (exchange) return exchange;
  const code = new URLSearchParams(location.hash.slice(1)).get("code");
  const clientId = location.pathname.split("/")[2],
    operationId = location.pathname.split("/")[3];
  history.replaceState(null, "", location.pathname);
  exchange = (async () => {
    if (!code)
      throw Error("Pedile al casino que abra una nueva sesión del sportsbook.");
    const response = await fetch("/api/integration/v1/embed-exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, clientId, operationId }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "Sesión inválida.");
    setEmbedAccess(result.accessToken);
    setEmbedContext({
      ...result.scope,
      channel: result.channel,
      terminalId: result.terminalId,
    });
  })();
  return exchange;
}
export function EmbedGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void startExchange()
      .then(() => {
        if (active) setReady(true);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  if (!ready)
    return (
      <div className="not-found">
        <h1>Apuesta DEPORTIVA LAT</h1>
        <p role={error ? "alert" : "status"}>
          {error || "Abriendo tu sesión segura…"}
        </p>
        <p>Simulación · Sin dinero real</p>
      </div>
    );
  return children;
}
