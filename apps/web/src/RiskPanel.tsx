import { useEffect, useState } from "react";
import { formatMinor, type Currency } from "@lsports/contracts";
const labels: Record<string, string> = {
  largeStake: "Importe alto",
  unusualStake: "Importe superior al historial",
  frequency: "Frecuencia de billetes",
  fragmentation: "Fragmentación por evento",
  eventConcentration: "Concentración por evento",
  marketConcentration: "Concentración por mercado",
  selectionConcentration: "Concentración por selección",
  operationExposure: "Exposición bruta de la operación",
  oddsJump: "Variación brusca de cuotas",
  feedHealth: "Salud del feed",
};
const states: Record<string, string> = {
  new: "Nuevo",
  review: "En análisis",
  closed: "Cerrado",
};
const signed = (amount: string, code: Currency) =>
  amount.startsWith("-")
    ? `−${formatMinor(amount.slice(1), code)}`
    : formatMinor(amount, code);
type Api = (path: string, method?: string, data?: unknown) => Promise<any>;
export default function RiskPanel({
  clientId,
  operationId,
  platformAdmin,
  api,
  onError,
  onNotice,
}: {
  clientId: string;
  operationId: string;
  platformAdmin: boolean;
  api: Api;
  onError: (s: string) => void;
  onNotice: (s: string) => void;
}) {
  const [data, setData] = useState<any[]>([]),
    [config, setConfig] = useState<any>(),
    [global, setGlobal] = useState(false),
    [busy, setBusy] = useState(false);
  const [event, setEvent] = useState(""),
    [player, setPlayer] = useState(""),
    [severity, setSeverity] = useState(""),
    [status, setStatus] = useState(""),
    [target, setTarget] = useState("event");
  const path = `/clients/${clientId}/operations/${operationId}/risk`;
  const query = new URLSearchParams({
    ...(event ? { eventId: event } : {}),
    ...(player ? { playerId: player } : {}),
    ...(severity ? { severity } : {}),
    ...(status ? { status } : {}),
  }).toString();
  async function load() {
    const result = await api(`${global ? "/risk" : path}?${query}`);
    const values = global ? result.operations : [result];
    setData(values);
    if (!config && !global) setConfig(result.config);
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    onError("");
    try {
      await fn();
    } catch (e) {
      onError(
        e instanceof Error ? e.message : "No se pudo completar la acción.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await api(`${global ? "/risk" : path}?${query}`);
        if (active) {
          setData(global ? result.operations : [result]);
          if (!global) setConfig((old: any) => old || result.config);
        }
      } catch (e) {
        if (active)
          onError(
            e instanceof Error ? e.message : "No se pudo actualizar riesgo.",
          );
      }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [path, query, global]);
  return (
    <>
      <section className="control-card">
        <h2>Control de riesgo · Solo simulación</h2>
        <p>
          Alertas informativas y bloqueos preventivos separados. Nunca se
          cambian cuotas aceptadas, se cancelan billetes ni se retienen pagos
          por sospecha. Las protecciones técnicas del feed son obligatorias.
        </p>
        {platformAdmin && (
          <label className="control-check">
            <input
              type="checkbox"
              checked={global}
              onChange={(e) => setGlobal(e.target.checked)}
            />{" "}
            Visión global autorizada (operaciones y monedas separadas)
          </label>
        )}
        <div className="control-risk-filters">
          <label>
            Evento
            <input
              value={event}
              onChange={(e) => setEvent(e.target.value)}
              placeholder="Fixture ID"
            />
          </label>
          <label>
            Jugador
            <input
              value={player}
              onChange={(e) => setPlayer(e.target.value)}
              placeholder="Referencia estable"
            />
          </label>
          <label>
            Gravedad
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
            >
              <option value="">Todas</option>
              <option value="info">Informativa</option>
              <option value="warning">Advertencia</option>
              <option value="high">Alta</option>
              <option value="critical">Crítica</option>
            </select>
          </label>
          <label>
            Situación
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Todas</option>
              {Object.entries(states).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p>
          Actualización local cada 5 segundos. Los filtros aplican a las
          alertas; la exposición incluye la operación completa. Sin consultas al
          proveedor.
        </p>
      </section>
      {data.map((d) => (
        <section key={d.scope.operationId} className="control-card">
          <h2>
            Operación <code>{d.scope.operationId}</code> · {d.scope.currency}
          </h2>
          <p>
            Cliente: <code>{d.scope.clientId}</code> · Actualizado{" "}
            {new Date(d.updatedAt).toLocaleString("es-AR")}
          </p>
          <div className="control-metrics">
            {[
              ["Apostado pendiente", d.exposure.stakeMinor],
              [
                "Retorno bruto potencial · cota",
                d.exposure.potentialGrossMinor,
              ],
              [
                "Pérdida conservadora · cota",
                d.exposure.conservativeLossBoundMinor,
              ],
            ].map(([label, value]) => (
              <article key={label}>
                <small>{label}</small>
                <p>
                  <strong>{formatMinor(value, d.scope.currency)}</strong>
                </p>
              </article>
            ))}
          </div>
          <p>
            Resultado neto: cota inferior{" "}
            {signed(
              d.exposure.conservativeNetLowerBoundMinor,
              d.scope.currency,
            )}
            . Se supone que todos los billetes pendientes pueden ganar
            simultáneamente; <strong>no es una pérdida exacta</strong>.
          </p>
          <details>
            <summary>
              Escenarios de apuestas simples y estimación de múltiples
            </summary>
            {d.exposure.simpleMarkets.map((m: any) => (
              <div key={`${m.eventId}:${m.marketId}`}>
                <h3>
                  Evento {m.eventId} · Mercado {m.marketId}
                </h3>
                <p>{m.assumption}</p>
                {m.scenarios.map((s: any) => (
                  <p key={s.selectionId}>
                    Resultado {s.selectionId} · Retorno bruto{" "}
                    {formatMinor(s.potentialGrossMinor, d.scope.currency)} ·
                    Neto {signed(s.netResultMinor, d.scope.currency)}
                  </p>
                ))}
              </div>
            ))}
            <p>
              Múltiples: {d.exposure.multiples.tickets} · Retorno bruto máximo
              conservador{" "}
              {formatMinor(
                d.exposure.multiples.potentialGrossBoundMinor,
                d.scope.currency,
              )}
              . No modela correlaciones ni probabilidades.
            </p>
          </details>
          <h3>Alertas ({d.alerts.length})</h3>
          {!d.alerts.length && (
            <p>
              No hay alertas para los filtros elegidos. Esto no valida la
              conexión ni garantiza ausencia de riesgo.
            </p>
          )}
          {d.alerts.map((a: any) => (
            <details
              className={`control-risk-alert severity-${a.severity}`}
              key={a.id}
            >
              <summary>
                <strong>{labels[a.kind] || "Protección técnica"}</strong> ·{" "}
                {(
                  {
                    info: "Informativa",
                    warning: "Advertencia",
                    high: "Alta",
                    critical: "Crítica",
                  } as Record<string, string>
                )[a.severity] || a.severity}{" "}
                · {states[a.status]} ·{" "}
                {a.action === "block"
                  ? "Prevención configurada / técnica"
                  : "Informativa"}
              </summary>
              <p>{a.reason}</p>
              <p>
                {a.attemptId
                  ? "Métrica del intento rechazado"
                  : "Métrica evaluada"}
                :{" "}
                {[
                  "largeStake",
                  "unusualStake",
                  "fragmentation",
                  "eventConcentration",
                  "marketConcentration",
                  "selectionConcentration",
                  "operationExposure",
                ].includes(a.kind)
                  ? formatMinor(a.metric, d.scope.currency)
                  : a.metric}
              </p>
              <p>
                Primera detección: {new Date(a.created).toLocaleString("es-AR")}{" "}
                · Última: {new Date(a.last_seen).toLocaleString("es-AR")} ·
                Evidencias: {a.occurrences}
              </p>
              <p>
                Jugador: {a.playerId || "Agregado de la operación"} · Evento:{" "}
                {a.eventId || "Varios"} · Mercado: {a.marketId || "—"} ·
                Selección: {a.selectionId || "—"}
              </p>
              {a.events.map((e: any) => (
                <p key={e.eventId}>
                  Evento {e.eventId} · Inicio informado:{" "}
                  {e.startDisplay || "No disponible"} ·{" "}
                  {e.live === null
                    ? "Estado no disponible"
                    : e.live
                      ? "En vivo"
                      : "No está en vivo"}{" "}
                  · Datos: {e.updatedAt || "Sin actualización informada"}
                </p>
              ))}
              <p>
                Billetes involucrados:{" "}
                {a.ticketIds.length
                  ? a.ticketIds.join(", ")
                  : "Sin billete aceptado asociado."}
              </p>
              {a.attemptId && (
                <p>
                  Intento rechazado: <code>{a.attemptId}</code> (no es un
                  billete aceptado).
                </p>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void action(async () => {
                    await api(
                      `/clients/${d.scope.clientId}/operations/${d.scope.operationId}/risk/alerts/${a.id}`,
                      "PATCH",
                      {
                        status: f.get("status"),
                        assignee: f.get("assignee"),
                        note: f.get("note"),
                      },
                    );
                    await load();
                    onNotice("Tratamiento de alerta registrado con auditoría.");
                  });
                }}
              >
                <label>
                  Situación
                  <select
                    name="status"
                    aria-label="Situación"
                    defaultValue={a.status}
                  >
                    {Object.entries(states).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Responsable
                  <input
                    name="assignee"
                    defaultValue={a.assignee || ""}
                    required
                    maxLength={150}
                  />
                </label>
                <label>
                  Observación
                  <textarea name="note" required maxLength={2000} />
                </label>
                <button disabled={busy}>Guardar tratamiento</button>
              </form>
              {a.notes.map((n: any, index: number) => (
                <p key={index}>
                  {new Date(n.at).toLocaleString("es-AR")} · {n.actor}: {n.text}
                </p>
              ))}
            </details>
          ))}
          <details>
            <summary>Auditoría de riesgo y suspensiones</summary>
            {d.audit.map((a: any) => (
              <p key={a.id}>
                {new Date(a.at).toLocaleString("es-AR")} · {a.actor} ·{" "}
                {a.action}
                <br />
                <code>{JSON.stringify(a.body)}</code>
              </p>
            ))}
          </details>
          <p>
            Histórico de cuotas: {d.priceHistory.reliableSamples} muestras
            confiables. {d.priceHistory.requirement}
          </p>
        </section>
      ))}
      {!global && (
        <>
          <form
            className="control-card control-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (
                !confirm(
                  "¿Aplicar esta suspensión/reactivación solo a nuevas jugadas?",
                )
              )
                return;
              void action(async () => {
                await api(`${path}/suspensions`, "POST", {
                  kind: target,
                  eventId: f.get("eventId"),
                  marketId: f.get("marketId"),
                  selectionId: f.get("selectionId"),
                  active: f.get("active") === "true",
                  reason: f.get("reason"),
                });
                await load();
                onNotice(
                  "Suspensión actualizada. Billetes aceptados y liquidaciones preservados.",
                );
              });
            }}
          >
            <h2>Suspender o reactivar nuevas jugadas</h2>
            <label>
              Destino
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="operation">Operación completa</option>
                <option value="event">Evento</option>
                <option value="market">Mercado de un evento</option>
                <option value="selection">Selección de un mercado</option>
              </select>
            </label>
            {target !== "operation" && (
              <label>
                Evento (fixture ID)
                <input name="eventId" required maxLength={100} />
              </label>
            )}
            {["market", "selection"].includes(target) && (
              <label>
                Mercado ID
                <input name="marketId" required maxLength={100} />
              </label>
            )}
            {target === "selection" && (
              <label>
                Selección ID
                <input name="selectionId" required maxLength={100} />
              </label>
            )}
            <label>
              Acción
              <select name="active">
                <option value="true">Suspender</option>
                <option value="false">Reactivar</option>
              </select>
            </label>
            <label>
              Motivo
              <textarea name="reason" required maxLength={1000} />
            </label>
            <button disabled={busy}>Aplicar a nuevas jugadas</button>
            <p>
              Reactivar aquí no supera suspensiones del cliente/operación ni
              bloqueos del proveedor.
            </p>
            {data[0]?.suspensions
              .filter((s: any) => s.active)
              .map((s: any, index: number) => (
                <p key={index}>
                  {s.kind} · {s.event_id} / {s.market_id} / {s.selection_id}:{" "}
                  {s.reason}
                </p>
              ))}
          </form>
          {config && (
            <form
              className="control-card control-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (
                  Object.values(config.rules).some(
                    (r: any) => r.enabled && r.action === "block",
                  ) &&
                  !confirm(
                    "Hay reglas con bloqueo automático explícito. ¿Confirmás aplicarlas solo a nuevas admisiones?",
                  )
                )
                  return;
                void action(async () => {
                  setConfig(await api(`${path}/config`, "PUT", config));
                  await load();
                  onNotice("Reglas determinísticas guardadas y auditadas.");
                });
              }}
            >
              <h2>Reglas determinísticas de la operación</h2>
              <p>
                Solo una regla habilitada con acción «Bloquear» puede producir
                un bloqueo automático por riesgo. No cambia las protecciones
                técnicas obligatorias ni los límites autorizados.
              </p>
              {Object.entries(config.rules).map(([kind, raw]) => {
                const rule = raw as any;
                const set = (key: string, value: unknown) =>
                  setConfig({
                    ...config,
                    rules: {
                      ...config.rules,
                      [kind]: { ...rule, [key]: value },
                    },
                  });
                return (
                  <details key={kind} className="control-risk-rule">
                    <summary>
                      {labels[kind]} ·{" "}
                      {rule.enabled
                        ? rule.action === "block"
                          ? "Bloqueo preventivo"
                          : "Solo alertas"
                        : "Deshabilitada"}
                    </summary>
                    <label className="control-check">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(e) => set("enabled", e.target.checked)}
                      />{" "}
                      Habilitar regla
                    </label>
                    <label>
                      Acción
                      <select
                        value={rule.action}
                        onChange={(e) => set("action", e.target.value)}
                      >
                        <option value="alert">Solo alertar</option>
                        <option value="block">Bloquear nueva jugada</option>
                      </select>
                    </label>
                    <label>
                      Gravedad
                      <select
                        value={rule.severity}
                        onChange={(e) => set("severity", e.target.value)}
                      >
                        <option value="info">Informativa</option>
                        <option value="warning">Advertencia</option>
                        <option value="high">Alta</option>
                        <option value="critical">Crítica</option>
                      </select>
                    </label>
                    {[
                      "largeStake",
                      "fragmentation",
                      "eventConcentration",
                      "marketConcentration",
                      "selectionConcentration",
                      "operationExposure",
                    ].includes(kind) && (
                      <label>
                        Umbral en unidades menores de la moneda
                        <input
                          value={rule.thresholdMinor}
                          inputMode="numeric"
                          pattern="[0-9]+"
                          onChange={(e) =>
                            set("thresholdMinor", e.target.value)
                          }
                        />
                      </label>
                    )}
                    {["frequency", "fragmentation"].includes(kind) && (
                      <label>
                        Cantidad de billetes
                        <input
                          type="number"
                          min="1"
                          value={rule.maxTickets}
                          onChange={(e) =>
                            set("maxTickets", Number(e.target.value))
                          }
                        />
                      </label>
                    )}
                    {["frequency", "fragmentation", "oddsJump"].includes(
                      kind,
                    ) && (
                      <label>
                        Ventana (milisegundos, máximo 3.600.000)
                        <input
                          type="number"
                          min="1"
                          max="3600000"
                          value={rule.windowMs}
                          onChange={(e) =>
                            set("windowMs", Number(e.target.value))
                          }
                        />
                      </label>
                    )}
                    {kind === "unusualStake" && (
                      <>
                        <label>
                          Muestras históricas mínimas
                          <input
                            type="number"
                            min="1"
                            max="1000"
                            value={rule.minHistory}
                            onChange={(e) =>
                              set("minHistory", Number(e.target.value))
                            }
                          />
                        </label>
                        <label>
                          Múltiplo de la media, en puntos básicos (30.000 = 3
                          veces)
                          <input
                            type="number"
                            min="1"
                            value={rule.multiplierBps}
                            onChange={(e) =>
                              set("multiplierBps", Number(e.target.value))
                            }
                          />
                        </label>
                      </>
                    )}
                    {kind === "oddsJump" && (
                      <label>
                        Variación mínima en puntos básicos (2.000 = 20%)
                        <input
                          type="number"
                          min="1"
                          value={rule.changeBps}
                          onChange={(e) =>
                            set("changeBps", Number(e.target.value))
                          }
                        />
                      </label>
                    )}
                  </details>
                );
              })}
              <label>
                IDs de mercados confirmados como mutuamente excluyentes
                (separados por coma)
                <input
                  value={config.exclusiveMarketIds.join(",")}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      exclusiveMarketIds: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <p>
                No declares exclusividad sin confirmar las reglas del mercado.
                Sin confirmación, la exposición no se presenta como pérdida
                exacta.
              </p>
              <button disabled={busy} className="control-primary">
                Guardar reglas de riesgo
              </button>
            </form>
          )}
        </>
      )}
    </>
  );
}
