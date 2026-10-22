// Bereich LinkedIn-Leads (docs/PLAN_LINKEDIN_LEADS.md L3): Personen, die auf einen
// beobachteten Post reagiert oder kommentiert haben — je Post gruppiert, mit Anlass,
// Firma und Mini-Profil. Übernehmen legt Firma und Person in einem Schritt an (L4),
// Ansprache öffnet den Chat vorbefüllt. Der ICP-Score ist hier nur ein Hinweis.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { LinkedInLead, LinkedInLeadPost } from "../../../shared/types";

type Status = "offen" | "uebernommen" | "ignoriert" | "ungeklaert";

const STATUS_LABEL: Record<Status, string> = { offen: "Offen", uebernommen: "Übernommen", ignoriert: "Ignoriert", ungeklaert: "Ungeklärt" };
const IGNORIER_GRUENDE = ["Kein Entscheider", "Falsche Branche", "Wettbewerber", "Kenne ich schon", "Sonstiges"];

function postKurz(url: string, titel: string | null): string {
  if (titel) return titel;
  try {
    const u = new URL(url);
    const teil = u.pathname.split("/").filter(Boolean).find((p) => p.includes("activity") || p.includes("posts")) ?? u.pathname;
    return teil.replace(/^(posts|activity)-?/, "").replace(/-/g, " ").slice(0, 70) || url;
  } catch {
    return url;
  }
}

function datum(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function LinkedInLeadsPanel(): JSX.Element {
  const navigate = useNavigate();
  const [posts, setPosts] = useState<LinkedInLeadPost[] | null>(null);
  const [status, setStatus] = useState<Status | "alle">("offen");
  const [postUrl, setPostUrl] = useState<string>("");
  const [nurKommentare, setNurKommentare] = useState(false);
  const [seite, setSeite] = useState(1);
  const [daten, setDaten] = useState<{ gesamt: number; items: LinkedInLead[] } | null>(null);
  const [laedt, setLaedt] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ignorierId, setIgnorierId] = useState<string | null>(null);
  const groesse = 50;

  const ladePosts = useCallback(async () => {
    try {
      const r = await window.api.linkedin.leads.posts();
      setPosts(r.posts);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      setPosts([]);
    }
  }, []);
  const lade = useCallback(async () => {
    setLaedt(true);
    try {
      const r = await window.api.linkedin.leads.list({ status: status === "offen" ? "offen" : status, postUrl: postUrl || undefined, nurKommentare, seite, groesse });
      setDaten(r);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      setDaten({ gesamt: 0, items: [] });
    } finally {
      setLaedt(false);
    }
  }, [status, postUrl, nurKommentare, seite]);
  useEffect(() => { void ladePosts(); }, [ladePosts]);
  useEffect(() => { void lade(); }, [lade]);

  const aktion = async (id: string, fn: () => Promise<unknown>, erfolg?: (r: unknown) => string | null): Promise<void> => {
    setBusy(id);
    setNotice(null);
    try {
      const r = await fn();
      const text = erfolg?.(r) ?? null;
      if (text) setNotice(text);
      await Promise.all([lade(), ladePosts()]);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const uebernehmen = (l: LinkedInLead) =>
    aktion(l.id, () => window.api.linkedin.leads.uebernehmen(l.id), (r) => {
      const x = r as { ok: boolean; hinweise: string[]; error?: string };
      return x.ok ? `${l.personName ?? "Person"} übernommen. ${x.hinweise.join(" ")}`.trim() : x.error ?? "Übernahme nicht möglich.";
    });

  const ansprache = (l: LinkedInLead): void => {
    const zeilen = [
      `Schlag mir eine kurze, persönliche Ansprache für ${l.personName ?? "diese Person"} vor.`,
      l.rolle || l.headline ? `Rolle: ${l.rolle ?? l.headline}` : null,
      l.firmaName ? `Firma: ${l.firmaName}${l.firmaOrt ? ` (${l.firmaOrt})` : ""}${l.firmaBranche ? ` — ${l.firmaBranche}` : ""}` : null,
      l.firmaKurz ? `Kurzprofil: ${l.firmaKurz}` : null,
      `Anlass: hat am ${datum(l.createdAt)} ${l.aktivitaet === "comment" ? "diesen Post kommentiert" : "auf diesen Post reagiert"}: ${l.postUrl}`,
      l.kommentar ? `Kommentar: „${l.kommentar}“` : null,
      `LinkedIn-Profil: ${l.profileUrl}`,
      "Bitte auf den Kommentar bzw. das Thema des Posts eingehen, kein Verkaufsdruck, Du-Form nur wenn der Kommentar sie nahelegt.",
    ].filter(Boolean);
    navigate("/chat", { state: { prefill: zeilen.join("\n") } });
  };

  const seiten = Math.max(1, Math.ceil((daten?.gesamt ?? 0) / groesse));
  const gruppen = useMemo(() => {
    const m = new Map<string, LinkedInLead[]>();
    for (const l of daten?.items ?? []) m.set(l.postUrl, [...(m.get(l.postUrl) ?? []), l]);
    return [...m.entries()];
  }, [daten]);
  const postInfo = (url: string) => posts?.find((p) => p.postUrl === url);

  if (posts && posts.length === 0) {
    return (
      <div className="ct-card wl">
        <p className="muted">
          Noch keine Leads. Lege unter „Beobachtete Posts“ einen LinkedIn-Post an — wer darauf reagiert oder kommentiert, erscheint hier mit Firma und Anlass.
        </p>
      </div>
    );
  }

  return (
    <div className="ct-card wl leads">
      <div className="leads__filter" role="group" aria-label="Filter">
        <div className="leads__chips" role="tablist">
          {(["offen", "ungeklaert", "uebernommen", "ignoriert", "alle"] as const).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={status === s} className={`radar-chip ${status === s ? "radar-chip--aktiv" : ""}`} onClick={() => { setStatus(s); setSeite(1); }}>
              {s === "alle" ? "Alle" : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <select value={postUrl} onChange={(e) => { setPostUrl(e.target.value); setSeite(1); }} aria-label="Post">
          <option value="">Alle Posts</option>
          {(posts ?? []).map((p) => (
            <option key={p.postUrl} value={p.postUrl}>{postKurz(p.postUrl, p.postTitel)} ({p.leads})</option>
          ))}
        </select>
        <label className="leads__check">
          <input type="checkbox" checked={nurKommentare} onChange={(e) => { setNurKommentare(e.target.checked); setSeite(1); }} /> nur Kommentare
        </label>
      </div>
      <p className="muted small">Leads gelten für deine ganze Organisation: Was eine Kollegin oder ein Kollege übernimmt oder ignoriert, verschwindet bei allen aus „Offen“ und steht mit Namen unter „Übernommen“ bzw. „Ignoriert“.</p>
      {notice && <p className="muted small">{notice}</p>}
      {laedt && !daten ? <p className="muted">Lädt…</p> : null}
      {daten && daten.items.length === 0 && !laedt && <p className="muted">Keine Leads für diesen Filter.</p>}
      {gruppen.map(([url, leads]) => {
        const info = postInfo(url);
        return (
          <section key={url} className="leads__post">
            <header className="leads__post-head">
              <div>
                <strong>{postKurz(url, info?.postTitel ?? null)}</strong>
                <div className="muted small">
                  {info ? `${info.leads} Leads · ${info.kommentare} Kommentare · ${info.uebernommen} übernommen · zuletzt ${datum(info.zuletzt)}` : ""}
                </div>
              </div>
              <button type="button" className="btn" onClick={() => void window.api.shell.openExternal(url)} title="Post auf LinkedIn öffnen">Post öffnen</button>
            </header>
            <ul className="leads__liste">
              {leads.map((l) => (
                <li key={l.id} className={`leads__lead leads__lead--${l.status}`}>
                  <div className="leads__person">
                    <div className="leads__name">
                      <button type="button" className="leads__link" onClick={() => void window.api.shell.openExternal(l.profileUrl)} title="LinkedIn-Profil öffnen">
                        {l.personName ?? "Unbekannte Person"}
                      </button>
                      {l.reaktionen > 1 && <span className="pill pill--active" title="Hat auf mehrere beobachtete Posts reagiert">{l.reaktionen} Posts</span>}
                      {l.status !== "offen" && <span className="pill">{STATUS_LABEL[l.status]}</span>}
                    </div>
                    <div className="muted small">{l.rolle ?? l.headline ?? ""}</div>
                    <div className="leads__anlass">
                      <span className={`pill ${l.aktivitaet === "comment" ? "pill--polling" : "pill--connecting"}`}>{l.aktivitaet === "comment" ? "Kommentar" : `Reaktion${l.reactionType ? ` · ${l.reactionType}` : ""}`}</span>
                      <span className="muted small">{datum(l.createdAt)}</span>
                    </div>
                    {l.kommentar && <blockquote className="leads__kommentar">„{l.kommentar}“</blockquote>}
                    {l.status === "ungeklaert" && <div className="muted small">Keine belastbare Firma: {l.grund ?? "unbekannt"}</div>}
                    {l.status === "uebernommen" && <div className="muted small">Übernommen{l.uebernommenVon ? ` von ${l.uebernommenVon}` : ""}{l.uebernommenAt ? ` am ${datum(l.uebernommenAt)}` : ""}</div>}
                    {l.status === "ignoriert" && <div className="muted small">Ignoriert{l.ignoriertVon ? ` von ${l.ignoriertVon}` : ""}{l.ignoriertGrund ? ` · ${l.ignoriertGrund}` : ""}</div>}
                  </div>
                  <div className="leads__firma">
                    {l.firmaName ? (
                      <>
                        <div className="leads__name">
                          {l.companyId ? (
                            <button type="button" className="leads__link" onClick={() => navigate(`/companies/${encodeURIComponent(l.companyId!)}`)}>{l.firmaName}</button>
                          ) : (
                            <span>{l.firmaName}</span>
                          )}
                          {l.konfidenz !== null && <span className="muted small" title="Wie sicher die Zuordnung Person → Firma ist">{l.konfidenz >= 0.9 ? "Zuordnung sicher" : "Zuordnung wahrscheinlich"}</span>}
                        </div>
                        <div className="muted small">{[l.firmaOrt, l.firmaDomain, l.firmaBranche].filter(Boolean).join(" · ")}</div>
                        {l.firmaKurz && <p className="leads__kurz">{l.firmaKurz}</p>}
                        {!l.firmaOrt && <div className="muted small">Mini-Profil folgt (Ort noch unbekannt).</div>}
                      </>
                    ) : (
                      <div className="muted small">Ohne Firma</div>
                    )}
                  </div>
                  <div className="leads__aktionen">
                    {l.status === "offen" && (
                      <>
                        <button type="button" className="btn btn--primary" disabled={busy === l.id || !l.firmaName} onClick={() => void uebernehmen(l)} title={l.firmaName ? "Firma in den Bestand, Person als Kontakt mit Anlass" : "Ohne Firma nicht übernehmbar"}>
                          {busy === l.id ? "…" : "Als Kontakt übernehmen"}
                        </button>
                        <button type="button" className="btn" onClick={() => ansprache(l)}>Ansprache vorschlagen</button>
                        {ignorierId === l.id ? (
                          <select autoFocus defaultValue="" onChange={(e) => { const g = e.target.value; setIgnorierId(null); if (g) void aktion(l.id, () => window.api.linkedin.leads.ignorieren(l.id, g)); }} onBlur={() => setIgnorierId(null)} aria-label="Grund">
                            <option value="" disabled>Grund wählen…</option>
                            {IGNORIER_GRUENDE.map((g) => <option key={g} value={g}>{g}</option>)}
                          </select>
                        ) : (
                          <button type="button" className="btn" disabled={busy === l.id} onClick={() => setIgnorierId(l.id)}>Ignorieren</button>
                        )}
                      </>
                    )}
                    {l.status === "ungeklaert" && <button type="button" className="btn" onClick={() => ansprache(l)}>Ansprache vorschlagen</button>}
                    {l.status === "ignoriert" && <button type="button" className="btn" disabled={busy === l.id} onClick={() => void aktion(l.id, () => window.api.linkedin.leads.zuruecknehmen(l.id))}>Zurück zu offen</button>}
                    {l.status === "uebernommen" && l.companyId && <button type="button" className="btn" onClick={() => navigate(`/companies/${encodeURIComponent(l.companyId!)}`)}>Firma öffnen</button>}
                    {l.status === "uebernommen" && l.companyId && !l.personId && (
                      <button type="button" className="btn" disabled={busy === l.id} title="Die Person wurde bei der Übernahme nicht als Kontakt angelegt" onClick={() => void aktion(l.id, () => window.api.linkedin.leads.kontaktNachholen(l.id), (r) => { const x = r as { ok: boolean; error?: string }; return x.ok ? "Kontakt angelegt." : x.error ?? "Kontakt nicht angelegt."; })}>
                        Kontakt nachholen
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {seiten > 1 && (
        <div className="leads__blaettern">
          <button type="button" className="btn" disabled={seite <= 1} onClick={() => setSeite((s) => s - 1)}>Zurück</button>
          <span className="muted small">Seite {seite} von {seiten}</span>
          <button type="button" className="btn" disabled={seite >= seiten} onClick={() => setSeite((s) => s + 1)}>Weiter</button>
        </div>
      )}
    </div>
  );
}
