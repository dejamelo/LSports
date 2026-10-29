import { useEffect, useState, type CSSProperties } from "react";
import { defaultTheme, type ThemeColors } from "./sportsbook-theme";

const labels: Record<keyof ThemeColors, string> = {
  primary: "Principal", secondary: "Secundaria", background: "Fondo", surface: "Superficies y tarjetas",
  text: "Textos", oddsButton: "Botones de odds", selected: "Selección marcada",
};
type ThemeRecord = { draft: ThemeColors; published: ThemeColors; revision: number };
type Props = { clientId: string; api: (path: string, method?: string, data?: unknown) => Promise<any>; onError: (message: string) => void; onNotice: (message: string) => void };
export default function SportsbookAppearance({ clientId, api, onError, onNotice }: Props) {
  const [record, setRecord] = useState<ThemeRecord>();
  const [draft, setDraft] = useState<ThemeColors>(defaultTheme);
  const [format, setFormat] = useState<"web" | "mobile" | "pos">("web");
  const [busy, setBusy] = useState(false);
  const base = `/clients/${encodeURIComponent(clientId)}/sportsbook-theme`;
  useEffect(() => { let active = true; void api(base).then((next: ThemeRecord) => { if (active) { setRecord(next); setDraft(next.draft); } }).catch((e: unknown) => onError(e instanceof Error ? e.message : "No se pudo cargar el tema.")); return () => { active = false; }; }, [clientId]);
  const run = async (fn: () => Promise<void>, message: string) => {
    setBusy(true); onError("");
    try { await fn(); onNotice(message); }
    catch (e) { onError(e instanceof Error ? e.message : "No se pudo guardar el tema."); }
    finally { setBusy(false); }
  };
  const previewStyle = Object.fromEntries(Object.entries(draft).map(([key, value]) => [`--theme-${key === "oddsButton" ? "odds-button" : key}`, value])) as CSSProperties;
  const sameTheme = (a: ThemeColors, b: ThemeColors) => Object.keys(a).every((key) => a[key as keyof ThemeColors] === b[key as keyof ThemeColors]);
  const unsaved = !!record && !sameTheme(draft, record.draft);
  const savedDraft = !!record && !sameTheme(record.draft, record.published);
  const themeState = unsaved
    ? "Cambios sin guardar. Usa Guardar borrador para conservarlos o Publicar para aplicarlos al sportsbook."
    : savedDraft
      ? `Borrador guardado, todavía no publicado. Revisión publicada ${record?.revision ?? 0}. Pulsa Publicar para aplicar los colores.`
      : record?.revision
        ? `Tema publicado · revisión ${record.revision}. Las nuevas sesiones del sportsbook reciben este tema.`
        : "Tema predeterminado Apuesta DEPORTIVA LAT publicado; todavía no hay una personalización guardada.";
  return <section className="control-card appearance-card">
    <div className="appearance-heading"><div><h2>Apariencia del sportsbook</h2><p role="status">{themeState}</p></div></div>
    <div className="appearance-grid">
      <div className="appearance-colors">
        {Object.entries(labels).map(([key, label]) => <label className="appearance-color" key={key}>{label}<span><input aria-label={label} type="color" value={draft[key as keyof ThemeColors]} onChange={(e) => setDraft((old) => ({ ...old, [key]: e.target.value.toUpperCase() }))}/><code>{draft[key as keyof ThemeColors]}</code></span></label>)}
        <p className="appearance-hint">Se aceptan colores hexadecimales. El servidor comprueba contraste AA antes de guardar.</p>
        <div className="appearance-actions">
          <button disabled={busy} onClick={() => void run(async () => { const next = await api(`${base}/draft`, "PUT", { theme: draft }); setRecord(next); }, "Borrador guardado.")}>Guardar borrador</button>
          <button className="control-primary" disabled={busy} onClick={() => void run(async () => { const published = await api(`${base}/publish`, "POST", { theme: draft }); setRecord(published); setDraft(published.draft); }, "Tema publicado para este cliente.")}>Publicar</button>
          <button disabled={busy} onClick={() => void run(async () => { const next = await api(`${base}/restore-default`, "POST", {}); setRecord(next); setDraft(next.draft); }, "Se restauró y publicó el tema predeterminado.")}>Restaurar Apuesta DEPORTIVA LAT</button>
        </div>
      </div>
      <div className="appearance-preview-wrap">
        <div className="appearance-preview-tabs" role="tablist" aria-label="Formato de vista previa">
          {(["web", "mobile", "pos"] as const).map((v) => <button key={v} role="tab" aria-selected={format === v} className={format === v ? "active" : ""} onClick={() => setFormat(v)}>{v === "web" ? "Web" : v === "mobile" ? "Mobile" : "POS"}</button>)}
        </div>
        <div className={`appearance-preview appearance-${format}`} style={previewStyle}>
          <header><strong>Apuesta <b>DEPORTIVA LAT</b></strong><span>PREVISUALIZACIÓN</span></header>
          <div className="appearance-preview-body"><nav><span>Fútbol</span><span>Tenis</span><span>Básquet</span></nav>
            <article><small>LIGA · EJEMPLO VISUAL</small><div className="appearance-teams"><b>Local</b><span>vs</span><b>Visitante</b></div><div className="appearance-odds"><button>1 <strong>—</strong></button><button className="sample-selected">X <strong>—</strong></button><button>2 <strong>—</strong></button></div><small>Sin datos deportivos · las rayas no son cuotas</small></article>
            {format !== "mobile" && <aside>Mi billete <small>La selección de muestra no se envía</small></aside>}
          </div>
          {format === "mobile" && <button className="appearance-mobile-slip">Mi billete · muestra</button>}
        </div>
        <p className="appearance-hint">Vista de componentes sin feed, precios ni apuestas.</p>
      </div>
    </div>
  </section>;
}
