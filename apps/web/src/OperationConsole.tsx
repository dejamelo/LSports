import { useEffect, useState, useRef } from "react";
import { formatMinor, type OperationTicket } from "@lsports/contracts";
import { ticketStatus } from "./TicketHistory";
type Api = (path: string, method?: string, data?: unknown) => Promise<any>;
export default function OperationConsole({
  path,
  tab,
  api,
  back,
  readOnly=false,
}: {
  path: string;
  tab: string;
  api: Api;
  back: () => void;
  readOnly?: boolean;
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
  const frame = useRef<HTMLIFrameElement>(null);
  const [availableHeight, setAvailableHeight] = useState(
    window.visualViewport?.height ?? innerHeight,
  );
  useEffect(() => {
    const resize = () =>
      setAvailableHeight(window.visualViewport?.height ?? innerHeight);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, []);
  const [format, setFormat] = useState("web"),
    [keyboard, setKeyboard] = useState(false),
    [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (url && (keyboard || document.activeElement === frame.current))
      requestAnimationFrame(() =>
        frame.current?.scrollIntoView({ block: "nearest" }),
      );
  }, [availableHeight, keyboard, url]);
  const dimensions = {
    web: { width: 1440, height: 900 },
    mobile: { width: 390, height: 844 },
    pos: { width: 480, height: 800 },
  }[format]!;
  const sendFormat = () =>
    frame.current?.contentWindow?.postMessage(
      { type: "adl.preview.presentation", format },
      location.origin,
    );
  useEffect(() => {
    if (!url) return;
    sendFormat();
    const ready = (event: MessageEvent) => {
      if (
        event.origin === location.origin &&
        event.source === frame.current?.contentWindow &&
        event.data?.type === "adl.preview.ready"
      )
        sendFormat();
    };
    window.addEventListener("message", ready);
    return () => window.removeEventListener("message", ready);
  }, [format, url]);
  useEffect(() => {
    if (!url || !frame.current) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0].contentRect;
      setSize({ width: Math.round(box.width), height: Math.round(box.height) });
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [url]);
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
            {readOnly?"Vista de plataforma · Solo lectura · Sin cliente, operación ni credencial ficticia. Usa la proyección local y mantiene bloqueadas las apuestas.":"Iframe de esta operación · Solo simulación · Jugador de prueba del administrador. Usa los datos locales del feed; no genera cuotas de prueba. Necesita una credencial vigente y este dominio autorizado en el cliente."}
          </p>
          {!url ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  if(readOnly){setFormat(channel);setKeyboard(false);setFrameLoading(true);setUrl(`/control/sportsbook-preview?format=${channel}`);return;}
                  const data = await api(`${path}/preview`, "POST", {
                    channel,
                    ...(channel === "pos" ? { terminalId } : {}),
                  });
                  setFormat(channel);
                  setKeyboard(false);
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
              {channel === "pos" && !readOnly && (
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
                {readOnly?"Abrir sportsbook de solo lectura":"Abrir sportsbook de simulación"}
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
                {readOnly?"Cerrar sportsbook de solo lectura":"Cerrar iframe y volver al resumen"}
              </button>
              <div className="preview-tools">
                <label>
                  Formato de la vista previa
                  <select
                    aria-label="Formato de la vista previa"
                    value={format}
                    onChange={(e) => setFormat(e.target.value)}
                  >
                    <option value="web">Web · hasta 1440 × 900</option>
                    <option value="mobile">Móvil · 390 × 844</option>
                    <option value="pos">POS · 480 × 800</option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={keyboard}
                    onChange={(e) => setKeyboard(e.target.checked)}
                  />
                  Simular teclado abierto (altura reducida)
                </label>
              </div>
              <p role="status">
                {readOnly?"Vista de solo lectura:":"Sesión:"}{" "}
                {channel === "mobile"
                  ? "Móvil"
                  : channel === "pos"
                    ? "POS"
                    : "Web"}{" "}
                · Vista real: {size.width} × {size.height} px. Cambiar el
                formato conserva la sesión y las selecciones; no cambia el canal
                autorizado. Altura reducida es una prueba de espacio disponible,
                no un teclado ni terminal físico validado.
              </p>
              {frameLoading && <p role="status">Abriendo sesión del iframe…</p>}
              <div className="preview-viewport">
                <iframe
                  ref={frame}
                  style={{
                    width: dimensions.width,
                    maxWidth: "100%",
                    height: Math.max(
                      Math.min(320, Math.max(200, availableHeight - 80)),
                      Math.min(dimensions.height, availableHeight - 120) -
                        (keyboard ? 320 : 0),
                    ),
                    minHeight: 0,
                  }}
                  title={readOnly?"Sportsbook de plataforma · solo lectura":"Sportsbook de simulación"}
                  className="control-sportsbook-frame"
                  src={url}
                  onLoad={() => {
                    setFrameLoading(false);
                    sendFormat();
                  }}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
                  referrerPolicy="no-referrer"
                />
              </div>
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
