import OperationConsole from "./OperationConsole";
import RiskPanel from "./RiskPanel";
import { useEffect, useState } from "react";
import {
  currencyPrecision,
  formatMinor,
  type Currency,
} from "@lsports/contracts";
export type Limits = {
  minStakeMinor: string;
  maxStakeMinor: string;
  maxReturnMinor: string;
  allowRepeatedTickets: boolean;
  maxTicketsPerPlayerEvent: number | null;
  maxStakePerPlayerEventMinor: string | null;
  sameEventMultiples: "blocked";
};
export type Operation = {
  id: string;
  clientId: string;
  currency: Currency;
  country: string;
  name: string;
  status: "active" | "suspended";
  acceptingTickets: boolean;
  clientMayEditLimits: boolean;
  limits: Limits;
  effectiveLimits: {
    limits: Limits;
    clientMayEdit: boolean;
    policyRevision: number;
  };
};
const defaults: Limits = {
  minStakeMinor: "1",
  maxStakeMinor: "100000000",
  maxReturnMinor: "9007199254740991",
  allowRepeatedTickets: true,
  maxTicketsPerPlayerEvent: null,
  maxStakePerPlayerEventMinor: null,
  sameEventMultiples: "blocked",
};
export function LimitFields({
  value,
  onChange,
  disabled = false,
  code,
}: {
  value: Limits;
  onChange: (value: Limits) => void;
  disabled?: boolean;
  code: Currency;
}) {
  const set = (key: keyof Limits, v: unknown) =>
    onChange({ ...value, [key]: v });
  return (
    <fieldset disabled={disabled} className="control-limits">
      <legend>
        Límites · {code} · {currencyPrecision[code]} decimales
      </legend>
      <p>
        Importes como enteros en unidades menores.{" "}
        {code === "CLP" || code === "PYG"
          ? "1 unidad menor = 1 unidad de moneda."
          : `100 unidades menores = 1,00 ${code}.`}{" "}
        Solo simulación.
      </p>
      {[
        ["minStakeMinor", "Mínimo por billete"],
        ["maxStakeMinor", "Máximo por billete"],
        ["maxReturnMinor", "Retorno potencial máximo"],
      ].map(([key, label]) => (
        <label key={key}>
          {label} ({code}, unidades menores)
          <input
            value={String(value[key as keyof Limits])}
            inputMode="numeric"
            pattern="[0-9]+"
            onChange={(e) => set(key as keyof Limits, e.target.value)}
            required
          />
        </label>
      ))}
      <label className="control-check">
        <input
          type="checkbox"
          checked={value.allowRepeatedTickets}
          onChange={(e) => set("allowRepeatedTickets", e.target.checked)}
        />{" "}
        Permitir nuevos billetes del jugador en el mismo evento
      </label>
      <label>
        Máximo de billetes por jugador/evento (vacío = sin límite)
        <input
          type="number"
          min="1"
          max="1000000"
          value={value.maxTicketsPerPlayerEvent ?? ""}
          onChange={(e) =>
            set(
              "maxTicketsPerPlayerEvent",
              e.target.value === "" ? null : Number(e.target.value),
            )
          }
        />
      </label>
      <label>
        Acumulado máximo por jugador/evento ({code}, unidades menores; vacío =
        sin límite)
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          value={value.maxStakePerPlayerEventMinor ?? ""}
          onChange={(e) =>
            set("maxStakePerPlayerEventMinor", e.target.value || null)
          }
        />
      </label>
      <p>
        <strong>Múltiples correlacionadas: bloqueadas.</strong> No se admite más
        de una selección del mismo evento. Sin soporte de precificación
        correlacionada.
      </p>
    </fieldset>
  );
}
type Api = (path: string, method?: string, data?: unknown) => Promise<any>;
export default function OperationWorkspace({
  clientId,
  platformAdmin,
  tab,
  api,
  onError,
  onNotice,
  onBack,
}: {
  clientId: string;
  platformAdmin: boolean;
  tab: string;
  api: Api;
  onError: (s: string) => void;
  onNotice: (s: string) => void;
  onBack: () => void;
}) {
  const [operations, setOperations] = useState<Operation[]>([]),
    [selected, setSelected] = useState(""),
    [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<"operation" | "policy" | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{
    kind: "operation" | "policy";
    error: boolean;
    message: string;
  } | null>(null);
  async function save(
    kind: "operation" | "policy",
    action: () => Promise<void>,
  ) {
    setSaving(kind);
    setSaveFeedback(null);
    onNotice("");
    await run(async () => {
      try {
        await action();
        setSaveFeedback({
          kind,
          error: false,
          message:
            kind === "operation"
              ? "Operación guardada."
              : "Política autorizada guardada.",
        });
      } catch (error) {
        setSaveFeedback({
          kind,
          error: true,
          message:
            error instanceof Error
              ? error.message
              : "No se pudo guardar. Revisá los datos y reintentá.",
        });
        throw error;
      } finally {
        setSaving(null);
      }
    });
  }
  const [keys, setKeys] = useState<any[]>([]),
    [diagnostic, setDiagnostic] = useState<any>(),
    [policies, setPolicies] = useState<Record<string, any>>({});
  const [limits, setLimits] = useState<Limits>(defaults),
    [policy, setPolicy] = useState<any>({ ...defaults, clientMayEdit: false }),
    [name, setName] = useState(""),
    [country, setCountry] = useState(""),
    [active, setActive] = useState(true),
    [edits, setEdits] = useState(false);
  const op = operations.find((o) => o.id === selected);
  const prefix = `/clients/${clientId}`,
    path = `${prefix}/operations/${selected}`;
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    onError("");
    try {
      await fn();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "No se pudo completar la operación.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function load() {
    const [result, p] = await Promise.all([
      api(`${prefix}/operations`),
      api(`${prefix}/limit-policies`),
    ]);
    setOperations(result.operations);
    setSelected((old) =>
      result.operations.some((o: Operation) => o.id === old)
        ? old
        : result.operations[0]?.id || "",
    );
    setPolicies(p.policies);
  }
  useEffect(() => {
    void run(load);
  }, [clientId]);
  useEffect(() => {
    if (op) {
      setLimits(op.limits);
      setName(op.name);
      setCountry(op.country);
      setActive(op.status === "active" && op.acceptingTickets);
      setEdits(op.clientMayEditLimits);
      setPolicy(policies[op.currency] || { ...defaults, clientMayEdit: false });
    }
  }, [op, policies]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    void Promise.all([api(`${path}/credentials`), api(`${path}/diagnostics`)])
      .then(([k, d]) => {
        if (active) {
          setKeys(k.credentials);
          setDiagnostic(d);
        }
      })
      .catch((e) => {
        if (active) onError(e.message);
      });
    return () => {
      active = false;
    };
  }, [selected, tab]);
  if (
    ![
      "Resumen",
      "Operaciones",
      "Credenciales",
      "Riesgo",
      "Sportsbook",
      "Billetes",
      "Terminales",
    ].includes(tab)
  )
    return null;
  const canEdit = platformAdmin || !!op?.effectiveLimits.clientMayEdit;
  return (
    <>
      <section className="control-card">
        <div className="control-inline">
          <label style={{ flex: 1, margin: 0 }}>
            Operación · moneda fija
            <select
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setCreating(false);
              }}
            >
              <option value="" disabled>
                Seleccioná una operación
              </option>
              {operations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} · {o.currency} · {o.country}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy} onClick={() => setCreating(!creating)}>
            Nueva operación
          </button>
        </div>
        <p>
          No se agregan saldos ni retornos de operaciones o monedas diferentes.
        </p>
      </section>
      {creating ? (
        <form
          className="control-card control-form"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void run(async () => {
              const result = await api(`${prefix}/operations`, "POST", {
                name: data.get("name"),
                country: data.get("country"),
                currency: data.get("currency"),
              });
              await load();
              setSelected(result.id);
              setCreating(false);
              onNotice(
                "Operación creada. La moneda es fija; las credenciales pertenecen a esta operación.",
              );
            });
          }}
        >
          <h2>Nueva operación</h2>
          <label>
            Nombre de la operación
            <input name="name" required maxLength={150} />
          </label>
          <label>
            País (código de dos letras)
            <input
              name="country"
              required
              maxLength={2}
              minLength={2}
              pattern="[a-zA-Z]{2}"
              placeholder="AR"
            />
          </label>
          <label>
            Moneda fija
            <select name="currency" aria-label="Moneda fija">
              {Object.keys(currencyPrecision).map((code) => (
                <option key={code}>{code}</option>
              ))}
            </select>
          </label>
          <button className="control-primary" disabled={busy}>
            Crear operación
          </button>
        </form>
      ) : !op ? (
        <section className="control-card">
          <h2>Creá una operación</h2>
          <p>
            Un cliente puede tener varias operaciones, incluso con la misma
            moneda. Cada una tiene sus propias credenciales, límites, billetes y
            reportes.
          </p>
        </section>
      ) : (
        <>
          <div className="control-status">
            <strong>
              {op.name} · {op.currency}
            </strong>
            <span>
              País: {op.country} ·{" "}
              {op.status === "active" && op.acceptingTickets
                ? "Admisión habilitada"
                : "Nuevos billetes suspendidos"}
            </span>
          </div>
          {diagnostic &&
            (diagnostic.health !== "ok" ||
              Object.values(diagnostic.connections || {}).some(
                (lane: any) => lane.phase !== "connected",
              )) && (
              <p role="status" className="control-error">
                Feed no disponible o incompleto. Los datos guardados no
                confirman cuotas vigentes. El servidor bloquea las selecciones
                sin validación actual; historial y resultados permanecen
                disponibles.
              </p>
            )}
          {tab === "Resumen" && (
            <>
              <div className="control-metrics">
                {[
                  ["Eventos", diagnostic?.events],
                  ["Mercados", diagnostic?.markets],
                  ["Billetes", diagnostic?.tickets.total],
                  ["Pendientes", diagnostic?.report.pendingTickets],
                ].map(([label, value]) => (
                  <article className="control-card" key={label}>
                    <span>{label}</span>
                    <strong>{value ?? "—"}</strong>
                  </article>
                ))}
              </div>
              <section className="control-card">
                <h2>Resumen de la operación · Simulación</h2>
                <p>
                  Importe aceptado:{" "}
                  {diagnostic?.report
                    ? formatMinor(
                        diagnostic.report.acceptedStakeMinor,
                        op.currency,
                      )
                    : "—"}
                  <br />
                  Retornos liquidados:{" "}
                  {diagnostic?.report
                    ? formatMinor(
                        diagnostic.report.settledReturnMinor,
                        op.currency,
                      )
                    : "—"}
                  <br />
                  Saldo de cartera: no conectado. No se inventa un saldo.
                </p>
                <p>
                  Operación: <code>{op.id}</code> · Datos:{" "}
                  {diagnostic?.updatedAt
                    ? new Date(diagnostic.updatedAt).toLocaleString("es-AR")
                    : "Sin actualización confirmada"}
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      setDiagnostic(await api(`${path}/diagnostics`)),
                    )
                  }
                >
                  Actualizar diagnóstico local
                </button>
                {Object.entries(diagnostic?.connections || {}).map(
                  ([lane, c]: [string, any]) => (
                    <article className="control-feed" key={lane}>
                      <h3>{lane === "prematch" ? "PreMatch" : "InPlay"}</h3>
                      <p>{c.message}</p>
                      <small>
                        Snapshot: {c.lastSnapshotAt || "Sin confirmar"} ·
                        Mensaje: {c.lastMessageAt || "Sin confirmar"}
                      </small>
                    </article>
                  ),
                )}
                <details>
                  <summary>Cobertura de snapshots y mercados</summary>
                  <pre>
                    {JSON.stringify(diagnostic?.coverage || {}, null, 2)}
                  </pre>
                </details>
                <h3>Billetes de esta operación</h3>
                {diagnostic?.tickets.recent.map((t: any) => (
                  <p key={t.id}>
                    <code>{t.id}</code> · {t.status} · Revisión {t.revision} ·{" "}
                    {t.payoutMinor === null
                      ? "Pendiente"
                      : formatMinor(t.payoutMinor, op.currency)}
                  </p>
                ))}
              </section>
            </>
          )}
          {["Sportsbook", "Billetes", "Terminales"].includes(tab) && (
            <OperationConsole
              key={`${path}:${tab}`}
              path={path}
              tab={tab}
              api={api}
              back={onBack}
            />
          )}
          {tab === "Operaciones" && (
            <>
              <form
                className="control-card control-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save("operation", async () => {
                    await api(path, "PATCH", {
                      name,
                      country,
                      status: active ? "active" : "suspended",
                      acceptingTickets: active,
                      ...(canEdit ? { limits } : {}),
                      ...(platformAdmin ? { clientMayEditLimits: edits } : {}),
                    });
                    await load();
                    onNotice(
                      "Operación actualizada. Los billetes aceptados y sus liquidaciones se preservan.",
                    );
                  });
                }}
              >
                <h2>Configuración de la operación</h2>
                <label>
                  Nombre
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </label>
                <label>
                  País
                  <input
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    maxLength={2}
                    minLength={2}
                    required
                  />
                </label>
                <p>
                  Moneda fija: <strong>{op.currency}</strong>. Para usar otra
                  moneda, creá otra operación.
                </p>
                <label className="control-check">
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={(e) => setActive(e.target.checked)}
                  />{" "}
                  Admitir nuevos billetes de esta operación
                </label>
                {platformAdmin && (
                  <label className="control-check">
                    <input
                      type="checkbox"
                      checked={edits}
                      onChange={(e) => setEdits(e.target.checked)}
                    />{" "}
                    Autorizar al cliente a editar límites de esta operación
                    (también requiere permiso de la política del cliente/moneda)
                  </label>
                )}
                <LimitFields
                  value={limits}
                  onChange={setLimits}
                  disabled={!canEdit}
                  code={op.currency}
                />
                {!canEdit && (
                  <p>
                    La plataforma no habilitó la edición de límites para esta
                    operación.
                  </p>
                )}
                <button disabled={busy} className="control-primary">
                  {saving === "operation"
                    ? "Guardando operación…"
                    : "Guardar operación"}
                </button>
                {saveFeedback?.kind === "operation" && (
                  <p
                    role={saveFeedback.error ? "alert" : "status"}
                    className={
                      saveFeedback.error ? "control-error" : "control-notice"
                    }
                  >
                    {saveFeedback.message}
                  </p>
                )}
                <details>
                  <summary>Límites efectivos autorizados</summary>
                  <pre>{JSON.stringify(op.effectiveLimits, null, 2)}</pre>
                </details>
              </form>
              {platformAdmin && (
                <form
                  className="control-card control-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save("policy", async () => {
                      await api(
                        `${prefix}/limit-policies/${op.currency}`,
                        "PATCH",
                        policy,
                      );
                      await load();
                      onNotice(
                        "Política autorizada actualizada. Solo afecta admisiones nuevas.",
                      );
                    });
                  }}
                >
                  <h2>Política autorizada · Cliente / {op.currency}</h2>
                  <p>
                    Aplica a todas las operaciones {op.currency} del cliente. La
                    operación puede ser más restrictiva. Un cambio nunca
                    modifica billetes aceptados.
                  </p>
                  <LimitFields
                    value={policy}
                    onChange={(v) => setPolicy({ ...policy, ...v })}
                    code={op.currency}
                  />
                  <label className="control-check">
                    <input
                      type="checkbox"
                      checked={!!policy.clientMayEdit}
                      onChange={(e) =>
                        setPolicy({
                          ...policy,
                          clientMayEdit: e.target.checked,
                        })
                      }
                    />{" "}
                    Permitir edición por el administrador del cliente
                  </label>
                  <button className="control-primary" disabled={busy}>
                    {saving === "policy"
                      ? "Guardando política…"
                      : "Guardar política autorizada"}
                  </button>
                  {saveFeedback?.kind === "policy" && (
                    <p
                      role={saveFeedback.error ? "alert" : "status"}
                      className={
                        saveFeedback.error ? "control-error" : "control-notice"
                      }
                    >
                      {saveFeedback.message}
                    </p>
                  )}
                </form>
              )}
            </>
          )}
          {tab === "Riesgo" && (
            <RiskPanel
              key={op.id}
              clientId={clientId}
              operationId={op.id}
              platformAdmin={platformAdmin}
              api={api}
              onError={onError}
              onNotice={onNotice}
            />
          )}
          {tab === "Credenciales" && (
            <section className="control-card">
              <h2>
                Credenciales · {op.name} / {op.currency}
              </h2>
              <p>
                Secreto solo en el servidor. Cada clave y sesión queda vinculada
                a este cliente, operación y moneda.
              </p>
              <form
                className="control-inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const name = new FormData(form).get("name");
                  void run(async () => {
                    await api(`${path}/credentials`, "POST", { name });
                    setKeys((await api(`${path}/credentials`)).credentials);
                    form.reset();
                    onNotice(
                      "Credencial generada. El secreto permanece en el archivo restringido del servidor.",
                    );
                  });
                }}
              >
                <input
                  aria-label="Nombre de la credencial"
                  name="name"
                  placeholder="Servidor del casino"
                  required
                  maxLength={100}
                />
                <button disabled={busy} className="control-primary">
                  Generar credencial
                </button>
              </form>
              {keys.map((k) => (
                <article className="control-key" key={k.id}>
                  <div>
                    <strong>{k.name}</strong>
                    <span>ID (no es el secreto)</span>
                    <code>{k.id}</code>
                    <small>
                      Archivo del backend: credentials/{k.id}.key, dentro de
                      PLATFORM_DATA_DIR. Usá su contenido completo como Bearer;
                      no este ID. Rotar crea otro archivo.
                    </small>
                    <small>
                      {k.revoked
                        ? "Revocada"
                        : `Activa · ${k.currency} · secreto solo en servidor`}
                    </small>
                  </div>
                  {!k.revoked && (
                    <div>
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (
                            confirm(
                              "¿Rotar esta credencial y revocar sus sesiones?",
                            )
                          )
                            void run(async () => {
                              await api(
                                `${path}/credentials/${k.id}/rotate`,
                                "POST",
                                { name: k.name },
                              );
                              setKeys(
                                (await api(`${path}/credentials`)).credentials,
                              );
                            });
                        }}
                      >
                        Rotar
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (confirm("¿Revocar esta credencial?"))
                            void run(async () => {
                              await api(
                                `${path}/credentials/${k.id}/revoke`,
                                "POST",
                                {},
                              );
                              setKeys(
                                (await api(`${path}/credentials`)).credentials,
                              );
                            });
                        }}
                      >
                        Revocar
                      </button>
                    </div>
                  )}
                </article>
              ))}
              <p>
                Iframe:{" "}
                <code>
                  /embed/{clientId}/{op.id}/sportsbook
                </code>
              </p>
            </section>
          )}
        </>
      )}
    </>
  );
}
