import {minorInput,stakeShortcuts,type StakeLimits} from "./stake-limits";
import {majorToMinor,formatMinor,minor,returnMinor} from '@lsports/contracts';
import { sportsbookApi, embedded, getEmbedContext } from "./sportsbook-api";
import { TicketHistory } from "./TicketHistory";
import { useEffect, useState, useRef } from "react";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  ChevronRight,
  Clock3,
  Flame,
  Globe2,
  Menu,
  Search,
  ShieldCheck,
  Ticket,
  Trash2,
  Trophy,
  X,
  Zap,
} from "lucide-react";
import { EventMarkets } from "./EventMarkets";
import type {
  EventFeed,
  Selection,
  Sport,
  SportEvent,
} from "@lsports/contracts";
type Pick = { event: SportEvent; selection: Selection };
const sports: { id: Sport; icon: string; name: string }[] = [
  { id: "futbol", icon: "⚽", name: "Fútbol" },
  { id: "tenis", icon: "🎾", name: "Tenis" },
  { id: "basquet", icon: "🏀", name: "Básquet" },
  { id: "hipica", icon: "🏇", name: "Hípica" },
  { id: "otros", icon: "🏆", name: "Otros deportes" },
];
const money = (v: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(v);
export default function App() {
  const embedScope=getEmbedContext();
  const [feed, setFeed] = useState<EventFeed & {client?:{displayName:string;acceptingTickets:boolean};effectiveLimits?:StakeLimits}>();
  const [error, setError] = useState("");
  const [tab, setTab] = useState("Prepartido");
  const [sport, setSport] = useState<Sport>("futbol");
  const [query, setQuery] = useState("");
  const [picks, setPicks] = useState<Pick[]>([]);
  const [amount, setAmount] = useState(embedded ? "" : "1000");
  const [message, setMessage] = useState("");
  const [messageKind,setMessageKind] = useState<"success"|"error">("error");
  const amountInitialized=useRef(false);
  useEffect(()=>{
    if(embedScope && feed?.effectiveLimits && !amountInitialized.current){
      setAmount(minorInput(feed.effectiveLimits.minStakeMinor,embedScope.currency));amountInitialized.current=true;
    }
  },[feed?.effectiveLimits,embedScope]);
  const [submitting,setSubmitting] = useState(false);
  const [ticketRefresh,setTicketRefresh] = useState(0);
  const submission = useRef<{payload:string;key:string} | undefined>(undefined);
  const inFlight = useRef(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [mobileSlip, setMobileSlip] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    const load = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await sportsbookApi("/events", {
          signal: controller.signal,
        });
        if(response.status===401)throw Error("Sesión vencida. Cerrá esta vista y pedí una nueva sesión al casino o desde el panel.");
        if (!response.ok) throw Error();
        const next = (await response.json()) as EventFeed & {client?:{displayName:string;acceptingTickets:boolean};effectiveLimits?:StakeLimits};
        if (
          !["demo", "connected"].includes(next.mode) ||
          !Array.isArray(next.events)
        )
          throw Error();
        if (!disposed) {
          setFeed(next);
          setError("");
        }
      } catch (failure) {
        if (!disposed)
          setError(failure instanceof Error&&failure.message.startsWith("Sesión vencida")?failure.message:"Sin conexión con la API. Cuotas y simulación bloqueadas.");
      } finally {
        clearTimeout(timeout);
        if (!disposed) timer = setTimeout(load, 3000);
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [attempt]);
  useEffect(() => {
    setPicks([]);
    setMessage("");
  }, [feed?.mode]);
  const connected = feed?.mode === "connected";
  const currentPicks = picks.map((p) => {
    if (!connected) return p;
    const event = feed.events.find((e) => e.id === p.event.id);
    const market = event?.markets?.find((m) =>
      m.selections.some((s) => s.id === p.selection.id),
    );
    const selection = market?.selections.find((s) => s.id === p.selection.id);
    return {
      event: event
        ? { ...event, market: market?.name || p.event.market }
        : p.event,
      selection: selection || { ...p.selection, available: false },
    };
  });
  const picksBlocked =
    !!error || feed?.client?.acceptingTickets === false ||
    currentPicks.some(
      (p) => p.selection.available === false || p.event.available === false,
    );
  const pricesChanged =
    connected &&
    currentPicks.some((p, i) => p.selection.odds !== picks[i].selection.odds);
  const chooseSport = (id: Sport) => {
    setSport(id);
    setQuery("");
    setTab(id === "hipica" ? "Hípica" : "Prepartido");
    setMobileMenu(false);
  };
  const chooseTab = (value: string) => {
    setTab(value);
    if (value === "Hípica") setSport("hipica");
    else if (sport === "hipica") setSport("futbol");
  };
  const events =
    feed?.events.filter(
      (e) =>
        e.sport === sport &&
        (tab === "Hípica" || (tab === "En vivo" ? e.live : !e.live)) &&
        `${e.home} ${e.away} ${e.league}`
          .toLocaleLowerCase("es-AR")
          .includes(query.toLocaleLowerCase("es-AR")),
    ) ?? [];
  const toggle = (event: SportEvent, selection: Selection) => {
    setMessage("");
    setPicks((old) =>
      old.some((p) => p.selection.id === selection.id)
        ? old.filter((p) => p.selection.id !== selection.id)
        : [...old.filter((p) => p.event.id !== event.id), { event, selection }],
    );
  };
  const odds = currentPicks.reduce((v, p) => v * p.selection.odds, 1);
  const stake = embedded ? 0 : Number(amount);
  let simulatedMinor='';
  let valid=false, amountError='';
  const limits=feed?.effectiveLimits;
  const oddsMicros=currentPicks.map(p=>Math.round(p.selection.odds*1000000));
  let simulatedReturn='';
  if(embedScope){
    if(!limits)amountError='Cargando los límites de la operación…';
    else try {
      simulatedMinor=majorToMinor(amount,embedScope.currency);
      const n=minor(simulatedMinor);
      if(n<minor(limits.minStakeMinor))amountError=`El mínimo por billete es ${formatMinor(limits.minStakeMinor,embedScope.currency)}.`;
      else if(n>minor(limits.maxStakeMinor))amountError=`El máximo por billete es ${formatMinor(limits.maxStakeMinor,embedScope.currency)}.`;
      else if(minor(returnMinor(simulatedMinor,oddsMicros))>minor(limits.maxReturnMinor))amountError=`El retorno potencial supera el máximo de ${formatMinor(limits.maxReturnMinor,embedScope.currency)}.`;
      else valid=true;
      simulatedReturn=formatMinor(returnMinor(simulatedMinor,oddsMicros),embedScope.currency);
    }catch(error){amountError=error instanceof Error?error.message:'Revisá el importe.';}
  }else valid=Number.isFinite(stake)&&stake>0&&stake<=1000000;
  const quickStakes=embedScope && limits ? stakeShortcuts(limits,oddsMicros).map(value=>({value:minorInput(value,embedScope.currency),label:formatMinor(value,embedScope.currency)})) : embedded ? [] : [500,1000,5000].map(value=>({value:String(value),label:money(value)}));
  const submitTicket = async () => {
    if(inFlight.current) return;
    const payload=JSON.stringify({...embedScope,stakeMinor:embedScope?simulatedMinor:Math.round(stake*100),selections:currentPicks.map(p=>({eventId:p.event.id,
      marketId:p.event.markets?.find(m=>m.selections.some(s=>s.id===p.selection.id))?.id || "demo",
      selectionId:p.selection.id,expectedOdds:p.selection.odds}))});
    if(!submission.current && !embedded) {
      try {const saved=JSON.parse(sessionStorage.getItem("adl-pending-test-ticket") || "null");
        if(saved?.payload===payload && typeof saved.key==="string") submission.current=saved;
      } catch { /* Storage is optional; API remains authoritative. */ }
    }
    if(submission.current?.payload!==payload) submission.current={payload,key:crypto.randomUUID()};
    try {if(!embedded)sessionStorage.setItem("adl-pending-test-ticket",JSON.stringify(submission.current));} catch {}
    inFlight.current=true;setSubmitting(true);setMessage("");setMessageKind("error");
    try {
      const r=await sportsbookApi("/tickets",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":submission.current.key},body:payload});
      const result=await r.json();
      if(!r.ok) {setMessage(result.error || "No se pudo aceptar el billete.");return;}
      if(r.status!==201 || typeof result.id!=='string' || !result.id){setMessage("Respuesta no confirmada. Revisá el historial antes de reintentar el mismo billete.");return;}
      setMessageKind("success");
      setMessage(`Billete de prueba registrado: ${result.id}. Sin dinero real.`);
      setTicketRefresh(n=>n+1);
    } catch {setMessage("Respuesta no confirmada. Reintentá sin cambiar el billete para evitar duplicados.");}
    finally{inFlight.current=false;setSubmitting(false);}
  };
  if (!embedded && location.pathname !== "/sportsbook" && location.pathname !== "/")
    return (
      <div className="not-found">
        <h1>Página no encontrada</h1>
        <a href="/sportsbook">Ir al sportsbook</a>
      </div>
    );
  return (
    <>
      <header className="header">
        <div className="brand" aria-label="Apuesta DEPORTIVA LAT">
          <span className="brand-icon" aria-hidden="true">
            ADL
          </span>
          <span className="brand-name">
            <span>Apuesta</span>
            <strong>DEPORTIVA LAT</strong>
          </span>
        </div>
        <nav>
          <a className="active" href="/sportsbook">
            Deportes
          </a>
          <button onClick={() => chooseTab("En vivo")}>
            En vivo <i />
          </button>
          <button onClick={() => chooseSport("hipica")}>Hípica</button>
        </nav>
        <div className="header-right">
          <span className="demo-pill">
            {connected ? "TRADE · TEST" : feed ? "MODO DEMO" : "CARGANDO"}
          </span>
          <span className="locale">
            AR <Globe2 size={15} />
          </span>
        </div>
      </header>
      <div className="demo-notice">
        <ShieldCheck size={14} />
        <span>
          {embedScope&&`${embedScope.currency} · SIMULACIÓN · `}{feed?.client?.displayName && `${feed.client.displayName} · `}{feed?.notice || "Consultando estado de la API… Sin dinero real."}
        </span>
        <span className="notice-age">18+</span>
      </div>
      <div className="layout">
        <aside className={`sidebar ${mobileMenu ? "expanded" : ""}`}>
          <div className="side-label">EXPLORÁ LA ACCIÓN</div>
          <button
            className="featured"
            onClick={() => {
              chooseSport("futbol");
              setQuery("");
            }}
          >
            <Flame size={18} /> Destacados <ChevronRight size={14} />
          </button>
          <div className="side-label sports-label">DEPORTES</div>
          {sports.map((s) => (
            <button
              key={s.id}
              onClick={() => chooseSport(s.id)}
              className={`sport ${sport === s.id ? "selected" : ""}`}
            >
              <span>{s.icon}</span>
              {s.name}
              <small>
                {feed?.events.filter((e) => e.sport === s.id).length ?? "–"}
              </small>
            </button>
          ))}
          <div className="side-label sports-label">COMPETICIONES POPULARES</div>
          {["Liga Profesional", "Champions League", "ATP"].map((l, i) => (
            <button
              className="league-link"
              key={l}
              onClick={() => {
                chooseSport(i === 2 ? "tenis" : "futbol");
                setQuery(l);
              }}
            >
              <Trophy size={15} />
              {l}
            </button>
          ))}
          <div className="sidebar-bottom">
            <ShieldCheck size={26} />
            <strong>
              La pasión se disfruta
              <br />
              con responsabilidad.
            </strong>
            <p>Solo simulación · Mayores de 18 años</p>
          </div>
        </aside>
        <main>
          <div className="breadcrumb">
            Deportes <ChevronRight size={12} /> Sportsbook
          </div>
          <section className="hero">
            <div className="hero-copy">
              <span className="eyebrow">
                <span /> TU PRÓXIMA GRAN JUGADA
              </span>
              <h1>
                La pasión se vive.
                <br />
                <em>El partido lo elegís vos.</em>
              </h1>
              <p>
                Todo el deporte, toda la emoción.
                <br />
                Explorá las cuotas y armá tu jugada de prueba.
              </p>
              <button
                onClick={() =>
                  document
                    .getElementById("events")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
              >
                Explorar eventos <ArrowUpRight size={17} />
              </button>
              <small>
                {connected
                  ? "Datos del proveedor · Sin apuestas reales"
                  : "Experiencia demo · Sin apuestas reales"}
              </small>
            </div>
            <div className="hero-art" aria-hidden="true">
              <div className="pitch-ring ring-one" />
              <div className="pitch-ring ring-two" />
              <div className="ball">⚽</div>
              <span className="art-tag">
                <Zap size={14} /> EL JUEGO NO PARA
              </span>
              <div className="field-line" />
            </div>
          </section>
          <div className="section-title">
            <div>
              <span className="eyebrow muted">TU CANCHA, TUS REGLAS</span>
              <h2>Encontrá tu próximo partido</h2>
            </div>
            <span className="fixture-badge">
              <Clock3 size={13} />{" "}
              {connected ? "Horarios ART" : "Agenda ilustrativa"}
            </span>
          </div>
          <div className="tabs" role="tablist" aria-label="Tipo de evento">
            {["Prepartido", "En vivo", "Hípica"].map((t) => (
              <button
                role="tab"
                aria-selected={tab === t}
                key={t}
                className={tab === t ? "current" : ""}
                onClick={() => chooseTab(t)}
              >
                {t === "En vivo" ? (
                  <span className="live-dot" />
                ) : t === "Hípica" ? (
                  <span>🏇</span>
                ) : (
                  <Clock3 size={16} />
                )}{" "}
                {t}
              </button>
            ))}
          </div>
          <div className="event-toolbar" id="events">
            <button
              className="mobile-menu"
              onClick={() => setMobileMenu(!mobileMenu)}
              aria-expanded={mobileMenu}
            >
              <Menu size={18} /> Deportes
            </button>
            <h3>
              {sports.find((s) => s.id === sport)?.icon}{" "}
              {sports.find((s) => s.id === sport)?.name}{" "}
              <span>{events.length} eventos</span>
            </h3>
            <label className="search">
              <Search size={16} />
              <input
                aria-label="Buscar equipos o competición"
                placeholder="Buscá un equipo o liga"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button
                  aria-label="Limpiar búsqueda"
                  onClick={() => setQuery("")}
                >
                  <X size={14} />
                </button>
              )}
            </label>
          </div>
          {connected && (
            <div
              className={`connection-panel ${feed.health !== "ok" ? "connection-warning" : ""}`}
              role="status"
            >
              <strong>
                Proveedor: LSports TRADE · Test ·{" "}
                {feed.health === "ok"
                  ? "Feed conectado"
                  : feed.health === "degraded"
                    ? "Conexión parcial"
                    : "Sin conexión confirmada"}
              </strong>
              <p>
                API: {feed.events.length} eventos · Visibles con
                deporte/aba/búsqueda actuales: {events.length}. Sin eventos
                ficticios de respaldo.
              </p>
              {Object.entries(feed.coverage || {}).map(([lane, c]) => (
                <p key={`coverage-${lane}`}>
                  {lane === "prematch" ? "PreMatch" : "InPlay"}: snapshot
                  proveedor {c.snapshot?.providerRows ?? "sin auditar"} → SDK{" "}
                  {c.snapshot?.sdkRows ?? "—"} · actualizaciones de eventos{" "}
                  {c.eventUpdatesReceived} · registros sin fixture{" "}
                  {c.rowsWithoutFixture} · publicados {c.rowsPublished} · con
                  cuotas seleccionables {c.eventsWithSelectableOdds}
                  {c.keepAliveActiveEvents !== undefined
                    ? ` · último KeepAlive ActiveEvents: ${c.keepAliveActiveEvents}`
                    : ""}
                </p>
              ))}
              {Object.entries(feed.connections || {}).map(([lane, state]) => (
                <p key={lane}>
                  {lane === "prematch" ? "PreMatch" : "InPlay"}: {state.message}
                  {state.lastSnapshotAt &&
                    ` · Snapshot ${new Date(state.lastSnapshotAt).toLocaleTimeString("es-AR")}`}
                </p>
              ))}
              <p>{feed.horseRacing?.message}</p>
            </div>
          )}
          <div className="event-list">
            {error ? (
              <div className="empty">
                <p>{error}</p>
                <button onClick={() => setAttempt((v) => v + 1)}>
                  Reintentar
                </button>
              </div>
            ) : !feed ? (
              <div className="empty" role="status">
                Cargando la cancha…
              </div>
            ) : events.length === 0 ? (
              <div className="empty">
                <Search size={28} />
                <h3>No hay eventos para esta selección</h3>
                <p>Probá otro deporte, pestaña o búsqueda.</p>
                <button onClick={() => setQuery("")}>Limpiar búsqueda</button>
              </div>
            ) : (
              events.map((event) => (
                <article className="event-card" key={event.id}>
                  <div className="event-league">
                    <Trophy size={13} />
                    {event.league}
                    <span>
                      {connected ? event.statusLabel || "TRADE" : "DEMO"}
                    </span>
                  </div>
                  <div className="event-body">
                    <div className="event-details">
                      <div
                        className={`event-time ${event.live ? "live-time" : ""}`}
                      >
                        {event.live && <span className="live-dot" />}
                        {event.time}
                      </div>
                      <strong>{event.home}</strong>
                      <strong className="away">{event.away}</strong>
                      {event.kind === "outright" && !!event.participants?.length && (
                        <details className="race-participants">
                          <summary>Ver participantes ({event.participants.length})</summary>
                          <ul>{event.participants.map((participant, index) => (
                            <li key={`${participant.id ?? index}:${index}`}>
                              {participant.position ? `${participant.position}. ` : ""}
                              {participant.name || "Nombre no informado"}
                              {participant.isActive === 0 ? " · Inactivo" : ""}
                            </li>
                          ))}</ul>
                        </details>
                      )}
                      {event.score && (
                        <span className="score">{event.score}</span>
                      )}
                    </div>
                    <EventMarkets
                      event={event}
                      selected={picks.map((p) => p.selection.id)}
                      blocked={!!error || feed?.client?.acceptingTickets === false || event.available === false}
                      onSelect={toggle}
                    />
                  </div>
                </article>
              ))
            )}
          </div>
          <div className="data-disclaimer">
            <ShieldCheck size={16} />
            <p>
              {connected
                ? "Datos de LSports TRADE en entorno Test. Las cuotas suspendidas, cerradas o sin conexión no se pueden seleccionar. Solo simulación."
                : "Eventos y cuotas ficticios. Modo demo separado de la integración real. Sin apuestas ni dinero real."}
            </p>
          </div>
          <TicketHistory refresh={ticketRefresh}/>
          <footer>
            <span>
              © {new Date().getFullYear()} Apuesta DEPORTIVA LAT ·{" "}
              {connected ? "TRADE Test" : "Experiencia demo"}
            </span>
            <span>Jugá con responsabilidad. 18+</span>
          </footer>
        </main>
        <aside className={`betslip ${mobileSlip ? "slip-open" : ""}`}>
          <div className="slip-title">
            <h2>
              <Ticket size={20} /> Mi billete <span>{picks.length}</span>
            </h2>
            <button
              className="close-slip"
              aria-label="Cerrar billete"
              onClick={() => setMobileSlip(false)}
            >
              <X size={18} />
            </button>
          </div>
          <div className="slip-mode">
            SIMULADOR <span>Sin dinero real</span>
          </div>
          {embedScope && limits && <section className="slip-limits" aria-label="Límites de la operación">
            <strong>Límites · {embedScope.currency}</strong>
            <p>Por billete: {formatMinor(limits.minStakeMinor,embedScope.currency)} a {formatMinor(limits.maxStakeMinor,embedScope.currency)}.</p>
            <p>Retorno potencial máximo: {formatMinor(limits.maxReturnMinor,embedScope.currency)}.</p>
            <p>{limits.allowRepeatedTickets ? 'Se permiten nuevos billetes del jugador en el mismo evento.' : 'Un solo billete del jugador por evento.'}</p>
            <p>Máximo por jugador/evento: {limits.maxTicketsPerPlayerEvent === null ? 'sin límite de cantidad configurado' : `${limits.maxTicketsPerPlayerEvent} ${limits.maxTicketsPerPlayerEvent===1?"billete":"billetes"}`}; acumulado: {limits.maxStakePerPlayerEventMinor === null ? 'sin límite configurado' : formatMinor(limits.maxStakePerPlayerEventMinor,embedScope.currency)}.</p>
            <p>Selecciones del mismo evento en una combinada: bloqueadas. El servidor verifica límites y acumulados actuales al confirmar.</p>
          </section>}
          {picks.length === 0 ? (
            <div className="slip-empty">
              <div className="ticket-art">
                <Ticket size={38} />
              </div>
              <h3>Tu jugada empieza acá</h3>
              <p>
                Elegí una cuota para agregar
                <br />
                tu primera selección al billete.
              </p>
              <div className="slip-hint">
                <span>1</span> Explorá los eventos
                <br />
                <span>2</span> Seleccioná tus cuotas
                <br />
                <span>3</span> Simulá tu combinación
              </div>
            </div>
          ) : (
            <>
              <div className="slip-type">
                {picks.length > 1 ? "Combinada" : "Simple"}
                <button
                  onClick={() => {
                    setPicks([]);
                    setMessage("");
                  }}
                >
                  <Trash2 size={13} /> Vaciar
                </button>
              </div>
              <div className="picks">
                {currentPicks.map((p) => (
                  <div className="pick" key={p.selection.id}>
                    <button
                      aria-label={`Quitar ${p.selection.label}`}
                      onClick={() => toggle(p.event, p.selection)}
                    >
                      <X size={14} />
                    </button>
                    <strong>
                      {p.selection.label === "1"
                        ? p.event.home
                        : p.selection.label === "2"
                          ? p.event.away
                          : p.selection.label === "X"
                            ? "Empate"
                            : p.selection.label}
                    </strong>
                    <p>
                      {p.event.home} · {p.event.away}
                    </p>
                    <span>
                      {p.event.market}
                      {p.selection.available === false
                        ? " · No disponible"
                        : ""}
                    </span>
                    <b>{p.selection.odds.toFixed(2)}</b>
                  </div>
                ))}
              </div>
              <div className="slip-summary">
                <div>
                  <span>Cuota total</span>
                  <strong>{odds.toFixed(2)}</strong>
                </div>
                <label htmlFor="stake">{embedScope?`Importe simulado (${embedScope.currency})`:'Importe ficticio (puntos)'}</label>
                <input
                  id="stake"
                  inputMode="decimal"
                  type={embedScope?"text":"number"}
                  min="1"
                  max="1000000"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setMessage("");
                  }}
                />
                {!valid && (
                  <p className="invalid" role="alert">{embedScope?amountError:"Ingresá entre 1 y 1.000.000 puntos."}</p>
                )}
                <div className="quick-stakes">
                  {quickStakes.map((shortcut) => (
                    <button
                      key={shortcut.value}
                      onClick={() => {
                        setAmount(shortcut.value);
                        setMessage("");
                      }}
                    >
                      {shortcut.label}
                    </button>
                  ))}
                </div>
                <div className="return">
                  <span>Retorno simulado</span>
                  <strong>
                    {embedScope ? simulatedReturn || "—" : valid ? money(stake * odds) : "—"} <small>{embedScope?"simulados":"pts"}</small>
                  </strong>
                </div>
                {picksBlocked && (
                  <p className="invalid">
                    {feed?.client?.acceptingTickets === false ? "Nuevos billetes suspendidos para esta operación. Los resultados pendientes siguen procesándose." : "Una selección no está habilitada o no se pudo verificar el feed. Revisá el estado y la conexión antes de confirmar."}
                  </p>
                )}
                {pricesChanged && (
                  <div className="invalid">
                    Las cuotas cambiaron.
                    <button
                      className="accept-prices"
                      onClick={() => {
                        setPicks(currentPicks);
                        setMessage("");
                      }}
                    >
                      Aceptar cuotas actualizadas
                    </button>
                  </div>
                )}
                <button
                  className="simulate"
                  disabled={submitting || !valid || picksBlocked || pricesChanged}
                  onClick={submitTicket}
                >
                  <Zap size={16} /> {submitting ? "Validando…" : "Simular billete"}
                </button>
                {messageKind==="success" && message.startsWith("Billete de prueba registrado:") && <button onClick={()=>{
                  submission.current=undefined;try{sessionStorage.removeItem("adl-pending-test-ticket");}catch{}setPicks([]);setMessage("");
                }}>Armar otro billete de prueba</button>}
                <p className="slip-fine">
                  {embedScope?`Simulación en ${embedScope.currency}. Sin dinero real, depósitos ni retiros.`:"Puntos ficticios. Sin depósitos ni retiros."}
                </p>
                {message && (
                  <div className={messageKind === "success" ? "success" : "ticket-error"} role={messageKind === "success" ? "status" : "alert"}>
                    {messageKind === "success" ? <Check size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
                    {message}
                  </div>
                )}
              </div>
            </>
          )}
          <div className="slip-bottom">
            <ShieldCheck size={16} />
            <span>
              Un espacio para explorar.
              <br />
              <strong>Sin riesgo. Sin dinero real.</strong>
            </span>
          </div>
        </aside>
      </div>
      <button
        className="mobile-slip-button"
        onClick={() => setMobileSlip(!mobileSlip)}
      >
        <Ticket size={19} /> Mi billete <b>{picks.length}</b>
      </button>
    </>
  );
}
