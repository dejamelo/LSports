import PlatformOverview from "./PlatformOverview";
import {useAdminIdleSession,announceAdminSession,type AdminSessionInfo} from "./useAdminIdleSession";
import OperationWorkspace from "./OperationWorkspace";
import { useEffect, useState, useRef } from "react";
import type { FormEvent } from "react";
import {
  ShieldCheck,
  Eye,
  EyeOff,
  Users,
  KeyRound,
  Activity,
  ScrollText,
  LogOut,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import "./control.css";
type Admin = {
  email: string;
  role: "platform_admin" | "client_admin";
  clientId: string | null;
};
type Client = {
  id: string;
  name: string;
  status: "active" | "suspended";
  domains: string[];
  settings: { acceptingTickets: boolean; displayName: string; locale: "es-AR" };
};
type Audit = {
  id: number | string;
  at: string;
  actor: string;
  action: string;
  client_id: string | null;
  details: unknown;
};
const auditLabels: Record<string, string> = {
  "operation.created": "Operación creada",
  "operation.updated": "Operación actualizada",
  "limits.policy.updated": "Política de límites actualizada",
  "risk.config.updated": "Reglas de riesgo actualizadas",
  "risk.alert.updated": "Tratamiento de alerta",
  "risk.suspension.updated": "Suspensión de nuevas jugadas actualizada",
  "client.created": "Cliente creado",
  "client.updated": "Configuración actualizada",
  "credential.created": "Credencial generada",
  "credential.rotated": "Credencial rotada",
  "credential.revoked": "Credencial revocada",
  "auth.login": "Ingreso al panel",
  "auth.logout": "Cierre de sesión",
  "auth.password.changed": "Contraseña actualizada",
  "auth.access.reset": "Acceso del cliente restablecido",
  "auth.access.recovered": "Acceso de plataforma recuperado",
  "terminal.updated": "Terminal registrado o actualizado",
  "embed.preview.created": "Vista previa del iframe abierta",
  "auth.login.rejected": "Ingreso rechazado",
  "platform.admin.created": "Administrador de plataforma creado",
};
export default function ControlPanel() {
  const [admin, setAdmin] = useState<Admin>(),
    [csrf, setCsrf] = useState(""),
    [loading, setLoading] = useState(true);
  const [mobileNavigation,setMobileNavigation]=useState(()=>matchMedia('(max-width: 650px)').matches);
  const [navigationOpen,setNavigationOpen]=useState(false);
  const navigationToggle=useRef<HTMLButtonElement>(null);
  useEffect(()=>{const media=matchMedia('(max-width: 650px)');const update=()=>{setMobileNavigation(media.matches);setNavigationOpen(false);};media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  useEffect(()=>{if(!navigationOpen)return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setNavigationOpen(false);navigationToggle.current?.focus();}};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[navigationOpen]);
  const [sessionInfo,setSessionInfo]=useState<AdminSessionInfo>();
  const [showAccountPasswords,setShowAccountPasswords]=useState(false);
  useAdminIdleSession(!!admin,csrf,sessionInfo,(reason)=>{setAdmin(undefined);setCsrf("");setClients([]);setSelected("");setSessionInfo(undefined);setError("");setNotice(reason);});
  const [recovering, setRecovering] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => setShowPassword(false), [admin]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [clients, setClients] = useState<Client[]>([]),
    [selected, setSelected] = useState(""),
    [tab, setTab] = useState("Resumen");
  const [audit, setAudit] = useState<Audit[]>([]);
  const [clientName, setClientName] = useState("");
  const [domains, setDomains] = useState(""),
    [displayName, setDisplayName] = useState(""),
    [accepting, setAccepting] = useState(true);
  const [creating, setCreating] = useState(false),
    [globalAudit, setGlobalAudit] = useState(false);
  const client = clients.find((c) => c.id === selected);
  async function api(
    path: string,
    method = "GET",
    data?: unknown,
    token = csrf,
  ) {
    const response = await fetch(`/api/control${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(method === "GET" ? {} : { "X-CSRF-Token": token }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      credentials: "same-origin",
      signal: AbortSignal.timeout(10000),
    }).catch(() => {
      throw Error(
        "No se pudo conectar con el panel. Verificá la conexión y reintentá.",
      );
    });
    const result = await response.json().catch(() => {
      throw Error(
        "Respuesta inválida del panel. Reintentá o contactá al administrador.",
      );
    });
    if (!response.ok) {
      if (response.status === 401 && path !== "/login") {
        announceAdminSession('logout',sessionInfo?.syncId||"");
        setAdmin(undefined);
        setCsrf("");
        setClients([]);
        setSelected("");
        throw Error("Tu sesión venció. Iniciá sesión nuevamente.");
      }
      throw Error(result.error || "No se pudo completar la operación.");
    }
    return result;
  }
  async function loadClients() {
    const result = await api("/clients");
    setClients(result.clients);
    setSelected((old) =>
      result.clients.some((c: Client) => c.id === old)
        ? old
        : result.clients[0]?.id || "",
    );
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "No se pudo completar la operación.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void api("/session")
      .then((result) => {
        if (active) {
          setAdmin(result.admin);
          setCsrf(result.csrf);
          setSessionInfo(result);
        }
      })
      .catch((e) => {
        if (active && !e.message.includes("sesión venció"))
          setError(
            "No se pudo verificar la sesión. Comprobá la conexión y reintentá.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    setGlobalAudit(false);
    if (admin) void action(loadClients);
  }, [admin]);
  useEffect(() => {
    if (client) {
      setClientName(client.name);
      setDomains(client.domains.join("\n"));
      setDisplayName(client.settings.displayName);
      setAccepting(client.settings.acceptingTickets);
    }
  }, [client]);
  useEffect(() => {
    if (!admin || (!selected && !(tab==="Auditoría" && admin.role==="platform_admin"))) return;
    let active = true;
    void api(
      (globalAudit || !selected) && admin.role === "platform_admin"
        ? "/audit"
        : `/audit?clientId=${selected}`,
    )
      .then((result) => {
        if (active) setAudit(result.entries);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [admin, selected, tab, globalAudit]);
  const login = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action(async () => {
      const result = await api("/login", "POST", {
        email: form.get("email"),
        password: form.get("password"),
      });
      announceAdminSession('login',result.syncId);
      setAdmin(result.admin);
      setCsrf(result.csrf);
      setSessionInfo(result);
    });
  };
  const save = () =>
    action(async () => {
      if (!client) return;
      await api(`/clients/${client.id}`, "PATCH", {
        name: clientName,
        domains: domains
          .split(/\n/)
          .map((s) => s.trim())
          .filter(Boolean),
        settings: { displayName, acceptingTickets: accepting, locale: "es-AR" },
      });
      await loadClients();
      setNotice(
        "Configuración guardada. Los resultados pendientes siguen procesándose.",
      );
    });
  const refresh = () =>
    action(async () => {
      await loadClients();
      setAudit(
        (
          await api(
            (globalAudit || !selected) && admin?.role === "platform_admin"
              ? "/audit"
              : `/audit?clientId=${selected}`,
          )
        ).entries,
      );
      setNotice("Datos locales actualizados. Sin consultas al proveedor.");
    });
  return (
    <div className={`control ${admin && tab === "Sportsbook" ? "control-preview-mode" : ""}`}>
      <header className="control-header">
        <a className="control-brand" href="/control">
          <span>ADL</span>
          <div>
            Apuesta <strong>DEPORTIVA LAT</strong>
            <small>CONTROL EXCLUSIVO</small>
          </div>
        </a>
        <span className="control-test">
          <ShieldCheck size={15} /> Entorno de prueba · Sin dinero real
        </span>
        {admin&&<button onClick={()=>{setNavigationOpen(false);setTab("Acceso");setCreating(false);setError("");setNotice("");setShowAccountPasswords(false);}} aria-label="Mi cuenta: cambiar mi contraseña">Mi cuenta · Cambiar contraseña</button>}
        {admin && (
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api("/logout", "POST", {});
                announceAdminSession('logout',sessionInfo?.syncId||"");
                setNotice("Sesión cerrada.");
                setAdmin(undefined);
                setCsrf("");
                setClients([]);
              })
            }
          >
            <LogOut size={16} /> Salir
          </button>
        )}
      </header>
      {!admin ? (
        <main className="control-login">
          <div className="control-intro">
            <span className="control-kicker">
              TU OPERACIÓN, EN UN SOLO LUGAR
            </span>
            <h1>
              Control para una
              <br />
              <em>plataforma propia.</em>
            </h1>
            <p>
              Administrá clientes, accesos y disponibilidad del sportsbook. Cada
              operador trabaja en su propio espacio.
            </p>
            <div>
              <ShieldCheck size={24} />
              <span>
                Acceso administrativo verificado en el servidor.
                <br />
                Sin credenciales del proveedor en el navegador.
              </span>
            </div>
          </div>
          <form onSubmit={login} className="control-card">
            <h2>Ingresá al panel</h2>
            {notice && <p role="status">{notice}</p>}
            <p>Usá tu cuenta de plataforma o de cliente.</p>
            <label>
              Email
              <input
                autoComplete="username"
                name="email"
                type="email"
                required
                maxLength={254}
              />
            </label>
            <label>
              Contraseña
              <span className="control-password">
                <input
                  id="control-login-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  maxLength={256}
                />
                <button
                  type="button"
                  aria-label={
                    showPassword ? "Ocultar contraseña" : "Mostrar contraseña"
                  }
                  aria-pressed={showPassword}
                  aria-controls="control-login-password"
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? (
                    <EyeOff size={19} aria-hidden="true" />
                  ) : (
                    <Eye size={19} aria-hidden="true" />
                  )}
                </button>
              </span>
            </label>
            {error && (
              <p role="alert" className="control-error">
                {error}
              </p>
            )}
            <button className="control-primary" disabled={busy || loading}>
              {loading
                ? "Verificando sesión…"
                : busy
                  ? "Ingresando…"
                  : "Ingresar"}
              <ChevronRight size={17} />
            </button>
            <button type="button" onClick={() => setRecovering((v) => !v)}>
              Recuperar acceso
            </button>
            {recovering && (
              <p role="status">
                Si administrás un cliente, pedile al administrador de la
                plataforma que restablezca tu acceso. Para recuperar la cuenta
                de plataforma, el responsable del servidor debe usar el
                procedimiento protegido de recuperación. No enviamos emails ni
                pedimos contraseñas por chat.
              </p>
            )}
            <small>
              El primer administrador se crea desde el servidor con{" "}
              <code>npm run platform:bootstrap</code>. No hay cuentas
              predeterminadas.
            </small>
          </form>
        </main>
      ) : (
        <div className="control-shell">
          <div className="control-mobile-navigation"><button ref={navigationToggle} className="control-menu-toggle" type="button" aria-label={navigationOpen?'Cerrar menú de navegación':'Abrir menú de navegación'} aria-expanded={navigationOpen} aria-controls="control-navigation" onClick={()=>setNavigationOpen(v=>!v)}>☰ Menú <span>{tab}</span></button></div>
          <aside id="control-navigation" className="control-nav" hidden={mobileNavigation&&!navigationOpen}>
            <span className="control-kicker">ESPACIO DE TRABAJO</span>
            <strong>
              {admin.role === "platform_admin"
                ? "Administración de plataforma"
                : "Administración del cliente"}
            </strong>
            <p>{admin.email}</p>
            <label>
              Cliente
              <select
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setNavigationOpen(false);setCreating(false);
                }}
              >
                <option value="" disabled>
                  Seleccioná un cliente
                </option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {admin.role === "platform_admin" && (
              <button onClick={() => {setNavigationOpen(false);setCreating(!creating);}}>
                <Users size={17} /> Nuevo cliente
              </button>
            )}
            {[
              { name: "Resumen", icon: Activity },
              { name: "Operaciones", icon: Users },
              { name: "Configuración", icon: ShieldCheck },
              { name: "Credenciales", icon: KeyRound },
              { name: "Riesgo", icon: Activity },
              { name: "Sportsbook", icon: Activity },
              { name: "Billetes", icon: ScrollText },
              { name: "Terminales", icon: Users },
              { name: "Acceso", icon: KeyRound },
              { name: "Auditoría", icon: ScrollText },
            ].map(({ name, icon: Icon }) => (
              <button
                key={name}
                className={tab === name ? "active" : ""}
                onClick={() => {
                  setTab(name);setNavigationOpen(false);
                  setError("");setNotice("");
                  setCreating(false);
                }}
              >
                <Icon size={17} />
                {name}
              </button>
            ))}
            <div className="control-wallet">
              <strong>Cartera del casino</strong>
              <p>
                Arquitectura preparada.
                <br />
                Contrato pendiente.
                <br />
                Operaciones solo en simulación.
              </p>
            </div>
          </aside>
          <main className="control-main">
            <div className="control-heading">
              <div>
                <span className="control-kicker">PLATAFORMA INDEPENDIENTE</span>
                <h1>
                  {creating
                    ? "Nuevo cliente"
                    : client?.name || "Empezá con tu primer cliente"}
                </h1>
                <p>
                  {creating
                    ? "Creá un espacio aislado y su administrador."
                    : `${tab} · Iframe, API y control del sportsbook`}
                </p>
              </div>
              {!creating && (
                <button disabled={busy} onClick={() => void refresh()}>
                  <RefreshCw size={16} /> Actualizar
                </button>
              )}
            </div>
            {error && (
              <p role="alert" className="control-error">
                {error}
              </p>
            )}
            {tab === "Acceso" && !creating && (
              <section className="control-card">
                <h2>Acceso administrativo</h2>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget,
                      data = new FormData(form);
                    void action(async () => {
                      await api("/password", "POST", {
                        currentPassword: data.get("current"),
                        newPassword: data.get("next"),
                        confirmPassword: data.get("confirm"),
                      });
                      announceAdminSession('logout',sessionInfo?.syncId||"");
                      form.reset();setShowAccountPasswords(false);
                      setAdmin(undefined);
                      setCsrf("");
                      setClients([]);
                      setNotice(
                        "Contraseña actualizada. Iniciá sesión nuevamente.",
                      );
                    });
                  }}
                >
                  <label>
                    Contraseña actual
                    <input
                      name="current"
                      type={showAccountPasswords?"text":"password"}
                      autoComplete="current-password"
                      required
                      maxLength={256}
                    />
                  </label>
                  <label>
                    Nueva contraseña
                    <input
                      name="next"
                      type={showAccountPasswords?"text":"password"}
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={256}
                    />
                  </label>
                  <label>Confirmar nueva contraseña<input name="confirm" type={showAccountPasswords?"text":"password"} autoComplete="new-password" required minLength={12} maxLength={256}/></label>
                  <button type="button" aria-pressed={showAccountPasswords} onClick={()=>setShowAccountPasswords(v=>!v)}>{showAccountPasswords?"Ocultar contraseñas":"Mostrar contraseñas"}</button>
                  <button disabled={busy}>{busy?"Cambiando contraseña…":"Cambiar mi contraseña"}</button>
                </form>
                {admin.role === "platform_admin" && client && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget,
                        data = new FormData(form);
                      void action(async () => {
                        await api(`/clients/${client.id}/access`, "POST", {
                          newPassword: data.get("password"),
                        });
                        form.reset();
                        setNotice(
                          "Acceso del cliente restablecido. Sesiones anteriores cerradas.",
                        );
                      });
                    }}
                  >
                    <h3>Restablecer acceso · {client.name}</h3>
                    <p>
                      Entregá la nueva contraseña por un canal seguro. No se
                      modifica ninguna credencial de integración.
                    </p>
                    <label>
                      Nueva contraseña del administrador del cliente
                      <input
                        name="password"
                        type="password"
                        autoComplete="new-password"
                        required
                        minLength={12}
                        maxLength={256}
                      />
                    </label>
                    <button disabled={busy}>
                      Restablecer acceso del cliente
                    </button>
                  </form>
                )}
              </section>
            )}
            {notice && (
              <p role="status" className="control-notice">
                {notice}
              </p>
            )}
                  {tab === "Auditoría" && !creating && (
                    <section className="control-card">
                      <h2>Actividad administrativa</h2>
                      <p>
                        Últimas 100 acciones del ámbito seleccionado. Sin
                        contraseñas, claves ni payloads del proveedor.
                      </p>
                      {admin.role === "platform_admin" && (
                        <label className="control-check">
                          <input
                            type="checkbox"
                            checked={globalAudit || !selected}
                            disabled={!selected}
                            onChange={(e) => setGlobalAudit(e.target.checked)}
                          />{" "}
                          Ver auditoría de toda la plataforma
                        </label>
                      )}
                      <div className="control-table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Fecha</th>
                              <th>Acción</th>
                              <th>Actor</th>
                              <th>Detalle</th>
                            </tr>
                          </thead>
                          <tbody>
                            {audit.map((a) => (
                              <tr key={a.id}>
                                <td>
                                  {new Date(a.at).toLocaleString("es-AR")}
                                </td>
                                <td>
                                  {auditLabels[a.action] || a.action}
                                  <br />
                                  <small>{a.action}</small>
                                </td>
                                <td>
                                  <code>{a.actor}</code>
                                </td>
                                <td>
                                  <code>{JSON.stringify(a.details)}</code>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  )}
            {creating ? (
              <form
                className="control-card control-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void action(async () => {
                    const result = await api("/clients", "POST", {
                      name: data.get("name"),
                      adminEmail: data.get("email"),
                      adminPassword: data.get("password"),
                      domains: String(data.get("domains") || "")
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    });
                    await loadClients();
                    setSelected(result.id);
                    setCreating(false);
                    setNotice("Cliente y administrador creados.");
                  });
                }}
              >
                <h2>Datos del operador</h2>
                <label>
                  Nombre del cliente
                  <input name="name" required maxLength={150} />
                </label>
                <label>
                  Email del administrador
                  <input
                    name="email"
                    type="email"
                    autoComplete="off"
                    required
                  />
                </label>
                <label>
                  Contraseña inicial del administrador
                  <input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={256}
                    required
                  />
                </label>
                <label>
                  Orígenes autorizados, uno por línea
                  <textarea
                    name="domains"
                    rows={3}
                    placeholder="https://casino.example"
                  />
                </label>
                <p>
                  HTTPS, sin rutas ni comodines. HTTP únicamente en localhost.
                </p>
                <button disabled={busy} className="control-primary">
                  Crear cliente
                </button>
              </form>
            ) : (
              client && (
                <>
                  <div className="control-status">
                    <span
                      className={
                        client.status === "active" &&
                        client.settings.acceptingTickets
                          ? "control-dot"
                          : "control-dot paused"
                      }
                    />
                    <strong>
                      {client.status === "suspended"
                        ? "Suspendido por la plataforma"
                        : client.settings.acceptingTickets
                          ? "Admisión de billetes habilitada"
                          : "Nuevos billetes pausados"}
                    </strong>
                    <span>Resultados y correcciones: procesamiento activo</span>
                  </div>
                  <OperationWorkspace
                    key={client.id}
                    clientId={client.id}
                    platformAdmin={admin.role === "platform_admin"}
                    tab={tab}
                    api={api}
                    onError={setError}
                    onNotice={setNotice}
                    onBack={() => setTab("Resumen")}
                  />
                  {tab === "Configuración" && (
                    <section className="control-card control-form">
                      <h2>Configuración del cliente</h2>
                      <label>
                        Nombre del cliente
                        <input
                          value={clientName}
                          maxLength={150}
                          onChange={(e) => setClientName(e.target.value)}
                        />
                      </label>
                      <label>
                        Nombre visible del operador
                        <input
                          value={displayName}
                          maxLength={150}
                          onChange={(e) => setDisplayName(e.target.value)}
                        />
                      </label>
                      <label>
                        Orígenes autorizados para el iframe
                        <textarea
                          rows={5}
                          value={domains}
                          onChange={(e) => setDomains(e.target.value)}
                          placeholder="https://casino.example"
                        />
                      </label>
                      <p>
                        Un origen exacto por línea. Sin dominios autorizados, el
                        iframe no se puede incorporar.
                      </p>
                      <label className="control-check">
                        <input
                          type="checkbox"
                          checked={accepting}
                          onChange={(e) => setAccepting(e.target.checked)}
                        />{" "}
                        Admitir nuevos billetes de prueba
                      </label>
                      <button
                        className="control-primary"
                        disabled={busy}
                        onClick={() => void save()}
                      >
                        Guardar configuración
                      </button>
                      {admin.role === "platform_admin" && (
                        <div className="control-danger">
                          <h3>Disponibilidad de la plataforma</h3>
                          <p>
                            Suspende nuevas jugadas del cliente. Conserva
                            consultas de historial, resultados y correcciones.
                          </p>
                          <button
                            disabled={busy}
                            onClick={() => {
                              if (
                                window.confirm(
                                  client.status === "active"
                                    ? "¿Suspender nuevos billetes de este cliente?"
                                    : "¿Reactivar este cliente?",
                                )
                              )
                                void action(async () => {
                                  await api(`/clients/${client.id}`, "PATCH", {
                                    status:
                                      client.status === "active"
                                        ? "suspended"
                                        : "active",
                                  });
                                  await loadClients();
                                });
                            }}
                          >
                            {client.status === "active"
                              ? "Suspender cliente"
                              : "Reactivar cliente"}
                          </button>
                        </div>
                      )}
                    </section>
                  )}

                </>
              )
            )}
            {!creating && !client && admin.role==="platform_admin" && ["Resumen","Sportsbook"].includes(tab)&&<PlatformOverview key={tab} api={api} sportsbook={tab==="Sportsbook"}/>}
            {!creating && !client && (
              <section className="control-card">
                <Users size={32} />
                <h2>{tab} · {clients.length?"Seleccioná un cliente":"Todavía no hay clientes"}</h2>
                <p>{["Resumen","Sportsbook","Auditoría","Acceso"].includes(tab)?"Podés consultar el estado global y administrar tu acceso sin crear un cliente.":`${tab} requiere un cliente seleccionado y, cuando corresponda, una operación con moneda fija.`}</p>
                <p>{admin.role==="platform_admin"?"Creá tu cliente real para configurar su operación, dominios y credenciales. No se importan datos del demo.":"Pedile al administrador de la plataforma que revise el cliente asignado a tu cuenta."}</p>
                {admin.role==="platform_admin"&&<button onClick={()=>setCreating(true)}>Crear primer cliente</button>}
              </section>
            )}
            <footer>
              ADL · Plataforma independiente · Operación en simulación
            </footer>
          </main>
        </div>
      )}
    </div>
  );
}
