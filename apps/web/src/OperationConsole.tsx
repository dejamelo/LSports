import { useEffect, useState } from "react";
import { formatMinor, type OperationTicket } from "@lsports/contracts";
import { ticketStatus } from "./TicketHistory";
type Api = (path: string, method?: string, data?: unknown) => Promise<any>;
export default function OperationConsole({
  path,
  tab,
  api,
  back,
}: {
  path: string;
  tab: string;
  api: Api;
  back: () => void;
}) {
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [page, setPage] = useState<any>(),
    [detail, setDetail] = useState<OperationTicket>();
  const [terminals, setTerminals] = useState<any[]>([]),
    [terminal, setTerminal] = useState({ id: "", name: "", status: "active" }),
    [revision, setRevision] = useState(0);
  const [url, setUrl] = useState(""),
    [frameLoading, setFrameLoading] = useState(false),
    [channel, setChannel] = useState("web"),
    [terminalId, setTerminalId] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    setPage(undefined);
    setDetail(undefined);
    if (!["Billetes", "Terminales"].includes(tab)) return;
    setLoading(true);
    void api(
      tab === "Billetes"
        ? `${path}/tickets?q=${encodeURIComponent(search)}&offset=${offset}`
        : `${path}/terminals`,
    )
      .then((data) => {
        if (active) {
          if (tab === "Billetes") setPage(data);
          else setTerminals(data.terminals);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, tab, search, offset, revision]);
  async function action(fn: () => Promise<void>) {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "No se pudo completar la operación.",
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <section className="control-card operation-console">
      <h2>{tab}</h2>
      {error && (
        <p role="alert" className="control-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Cargando…</p>}
      {tab === "Sportsbook" && (
        <>
          <p>
            Iframe de esta operación · Solo simulación · Jugador de prueba del
            administrador. Usa los datos locales del feed; no genera cuotas de
            prueba. Necesita una credencial vigente y este dominio autorizado en
            el cliente.
          </p>
          {!url ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  const data = await api(`${path}/preview`, "POST", {
                    channel,
                    ...(channel === "pos" ? { terminalId } : {}),
                  });
                  setFrameLoading(true);
                  setUrl(data.iframeUrl);
                });
              }}
            >
              <label>
                Canal de la vista previa
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                >
                  <option value="web">Web</option>
                  <option value="mobile">Móvil</option>
                  <option value="pos">POS</option>
                </select>
              </label>
              {channel === "pos" && (
                <label>
                  ID de terminal
                  <input
                    required
                    minLength={8}
                    maxLength={128}
                    value={terminalId}
                    onChange={(e) => setTerminalId(e.target.value)}
                  />
                </label>
              )}
              <button disabled={loading} className="control-primary">
                Abrir sportsbook de simulación
              </button>
            </form>
          ) : (
            <>
              <button
                onClick={() => {
                  setUrl("");
                  back();
                }}
              >
                Cerrar iframe y volver al resumen
              </button>
              {frameLoading && <p role="status">Abriendo sesión del iframe…</p>}
              <iframe
                title="Sportsbook de simulación"
                className="control-sportsbook-frame"
                src={url}
                onLoad={() => setFrameLoading(false)}
                sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
                referrerPolicy="no-referrer"
              />
              <p>
                Si la sesión vence, cerrá esta vista y abrí una nueva. El
                backend mantiene los bloqueos por feed y cuotas no vigentes.
              </p>
            </>
          )}
        </>
      )}
      {tab === "Billetes" && (
        <>
          <form
            className="control-inline"
            onSubmit={(e) => {
              e.preventDefault();
              setOffset(0);
              setSearch(query);
              setRevision((x) => x + 1);
            }}
          >
            <label>
              Buscar por ID de billete o jugador
              <input
                value={query}
                maxLength={120}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <button disabled={loading}>Buscar billetes</button>
          </form>
          {page && (
            <>
              <p>
                {page.total} billetes · Importes separados por operación y
                moneda.
              </p>
              {page.tickets.length === 0 && (
                <p>No hay billetes para esta búsqueda.</p>
              )}
              {page.tickets.map((t: OperationTicket) => (
                <button
                  className="control-ticket-row"
                  key={t.id}
                  onClick={() =>
                    void action(async () =>
                      setDetail(
                        await api(
                          `${path}/tickets/${encodeURIComponent(t.id)}`,
                        ),
                      ),
                    )
                  }
                >
                  <code>{t.id}</code> · {ticketStatus[t.status]} ·{" "}
                  {formatMinor(t.stakeMinor, t.currency)} ·{" "}
                  {new Date(t.createdAt).toLocaleString("es-AR")}
                </button>
              ))}
              {offset > 0 && (
                <button
                  disabled={loading}
                  onClick={() => setOffset(Math.max(0, offset - 30))}
                >
                  Anteriores
                </button>
              )}
              {page.nextOffset !== null && (
                <button
                  disabled={loading}
                  onClick={() => setOffset(page.nextOffset)}
                >
                  Más billetes
                </button>
              )}
            </>
          )}
          {detail && (
            <article aria-label="Detalle del billete">
              <h3>Billete {detail.id}</h3>
              <p>
                {ticketStatus[detail.status]} · Revisión {detail.revision} ·
                Cuota aceptada preservada
              </p>
              <p>
                Importe: {formatMinor(detail.stakeMinor, detail.currency)} ·
                Retorno:{" "}
                {detail.payoutMinor === null
                  ? "Pendiente"
                  : formatMinor(detail.payoutMinor, detail.currency)}
              </p>
              <ul>
                {detail.selections.map((s) => (
                  <li key={s.selectionId}>
                    {s.eventName} · {s.marketName} · {s.selectionName} · Cuota
                    aceptada {s.acceptedOdds} · {s.resultDescription}
                  </li>
                ))}
              </ul>
              <ol>
                {detail.history.map((h) => (
                  <li key={h.revision}>
                    {new Date(h.at).toLocaleString("es-AR")} ·{" "}
                    {ticketStatus[h.status]} · {h.reason}
                  </li>
                ))}
              </ol>
            </article>
          )}
        </>
      )}
      {tab === "Terminales" && (
        <>
          <p>
            Registro por operación. Al registrar el primer terminal, las
            sesiones POS de esta operación requieren un ID registrado y activo.
            Suspender un terminal bloquea su acceso POS; los billetes aceptados
            siguen liquidándose. El registro no verifica físicamente el
            dispositivo ni instala el APK.
          </p>
          {terminals.length === 0 && !loading && (
            <p>
              Sin terminales registrados; la integración POS conserva su
              contrato previo.
            </p>
          )}
          {terminals.map((t) => (
            <button
              className="control-ticket-row"
              key={t.id}
              onClick={() => setTerminal(t)}
            >
              {t.name} · {t.id} ·{" "}
              {t.status === "active" ? "Activo" : "Suspendido"}
            </button>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await api(`${path}/terminals`, "POST", terminal);
                setRevision((x) => x + 1);
                setNotice("Terminal guardado.");
              });
            }}
          >
            <label>
              ID de terminal
              <input
                required
                minLength={8}
                maxLength={128}
                pattern="[a-zA-Z0-9:_-]+"
                value={terminal.id}
                onChange={(e) =>
                  setTerminal({ ...terminal, id: e.target.value })
                }
              />
            </label>
            <label>
              Nombre del terminal
              <input
                required
                value={terminal.name}
                onChange={(e) =>
                  setTerminal({ ...terminal, name: e.target.value })
                }
              />
            </label>
            <label>
              Estado del terminal
              <select
                value={terminal.status}
                onChange={(e) =>
                  setTerminal({ ...terminal, status: e.target.value })
                }
              >
                <option value="active">Activo</option>
                <option value="suspended">Suspendido</option>
              </select>
            </label>
            <button disabled={loading} className="control-primary">
              Guardar terminal
            </button>
            <button
              type="button"
              onClick={() =>
                setTerminal({ id: "", name: "", status: "active" })
              }
            >
              Nuevo terminal
            </button>
          </form>
        </>
      )}
    </section>
  );
}
