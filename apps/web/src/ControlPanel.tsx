import OperationWorkspace from "./OperationWorkspace";
import { useEffect, useState } from "react";
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
  "auth.login.rejected": "Ingreso rechazado",
  "platform.admin.created": "Administrador de plataforma creado",
};
export default function ControlPanel() {
  const [admin, setAdmin] = useState<Admin>(),
    [csrf, setCsrf] = useState(""),
    [loading, setLoading] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => setShowPassword(false), [admin]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [clients, setClients] = useState<Client[]>([]),
    [selected, setSelected] = useState(""),
    [tab, setTab] = useState("Resumen");
  const [audit, setAudit] = useState<Audit[]>([]);
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
    });
    const result = await response.json().catch(() => ({
      error: "Panel no disponible. Verificá PLATFORM_ENABLED y el build.",
    }));
    if (!response.ok) {
      if (response.status === 401 && path !== "/login") setAdmin(undefined);
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
        }
      })
      .catch(() => {})
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
      setDomains(client.domains.join("\n"));
      setDisplayName(client.settings.displayName);
      setAccepting(client.settings.acceptingTickets);
    }
  }, [client]);
  useEffect(() => {
    if (!admin || !selected) return;
    let active = true;
    void api(
      globalAudit && admin.role === "platform_admin"
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
      setAdmin(result.admin);
      setCsrf(result.csrf);
    });
  };
  const save = () =>
    action(async () => {
      if (!client) return;
      await api(`/clients/${client.id}`, "PATCH", {
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
            globalAudit && admin?.role === "platform_admin"
              ? "/audit"
              : `/audit?clientId=${selected}`,
          )
        ).entries,
      );
      setNotice("Datos locales actualizados. Sin consultas al proveedor.");
    });
  return (
    <div className="control">
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
        {admin && (
          <button
            onClick={() =>
              void action(async () => {
                await api("/logout", "POST", {});
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
            <small>
              El primer administrador se crea desde el servidor con{" "}
              <code>npm run platform:bootstrap</code>. No hay cuentas
              predeterminadas.
            </small>
          </form>
        </main>
      ) : (
        <div className="control-shell">
          <aside className="control-nav">
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
                  setCreating(false);
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
              <button onClick={() => setCreating(!creating)}>
                <Users size={17} /> Nuevo cliente
              </button>
            )}
            {[
              { name: "Resumen", icon: Activity },
              { name: "Operaciones", icon: Users },
              { name: "Configuración", icon: ShieldCheck },
              { name: "Credenciales", icon: KeyRound },
              { name: "Riesgo", icon: Activity },
              { name: "Auditoría", icon: ScrollText },
            ].map(({ name, icon: Icon }) => (
              <button
                key={name}
                className={tab === name ? "active" : ""}
                onClick={() => {
                  setTab(name);
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
              {selected && !creating && (
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
            {notice && (
              <p role="status" className="control-notice">
                {notice}
              </p>
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
                  />
                  {tab === "Configuración" && (
                    <section className="control-card control-form">
                      <h2>Configuración del cliente</h2>
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
                  {tab === "Auditoría" && (
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
                            checked={globalAudit}
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
                </>
              )
            )}
            {!creating && !client && (
              <section className="control-card">
                <Users size={32} />
                <h2>Un espacio para cada operador</h2>
                <p>
                  {admin.role === "platform_admin"
                    ? "Creá el primer cliente para configurar su iframe, accesos y administrador."
                    : "No hay un cliente disponible para tu cuenta."}
                </p>
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
