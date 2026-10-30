// Fokus-Themen (docs/PLAN_THEMEN.md, T1): Einstellungen → Datenquellen.
// Themen anlegen, Begriffe pflegen, ein-/ausschalten, Begriffe von AVA ergaenzen lassen.
import { useEffect, useState } from "react";
import type { Thema } from "../../../../shared/themen-types";

const MAX_AKTIV = 5;

export function ThemenSection() {
  const [themen, setThemen] = useState<Thema[] | null>(null);
  const [offen, setOffen] = useState<string | "neu" | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState<string | null>(null);

  const laden = () => void window.api.themen.list().then(setThemen).catch((e: unknown) => setFehler(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    laden();
  }, []);

  if (!themen) return null;
  const aktive = themen.filter((t) => t.aktiv).length;

  const speichern = async (e: { id?: string; name: string; beschreibung: string; warum: string; begriffe: string[]; aktiv?: boolean }) => {
    setFehler(null);
    try {
      await window.api.themen.save(e);
      setOffen(null);
      laden();
    } catch (err) {
      setFehler(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : String(err));
    }
  };
  const ergaenzen = async (id: string) => {
    setFehler(null);
    setLaeuft(id);
    try {
      await window.api.themen.begriffe(id);
      laden();
    } catch (err) {
      setFehler(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : String(err));
    } finally {
      setLaeuft(null);
    }
  };

  return (
    <section className="provider-section alerts-prefs" id="themen-section">
      <h3>Fokus-Themen</h3>
      <p className="muted">
        Was dich persönlich an einer Firma interessiert und wonach AVA auf der Website jeder Firma zusätzlich sucht, zum Beispiel „Betriebliche Altersvorsorge“, „ISO 27001“ oder „Photovoltaik“. Je Thema wählt AVA
        passende Seiten, sucht nach den Begriffen und prüft die Fundstellen. Ein Fund trägt immer ein wörtliches Zitat und die Seite als Quelle. Bis zu {MAX_AKTIV} Themen
        gleichzeitig aktiv. Im Chat: „Leg ein Fokus-Thema an“.
      </p>
      {fehler && <p className="error small">{fehler}</p>}
      {themen.length === 0 && offen !== "neu" && <p className="muted small">Noch keine Themen. AVA prüft dann nur Stellenanzeigen und Arbeitgeberleistungen.</p>}
      <ul className="themen-liste" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {themen.map((t) => (
          <li key={t.id} className="panel" style={{ marginBottom: 10, padding: 12 }}>
            {offen === t.id ? (
              <ThemaFormular thema={t} onAbbruch={() => setOffen(null)} onSpeichern={(e) => speichern({ ...e, id: t.id })} />
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <strong>{t.name}</strong>
                  <label className="alerts-prefs__check" title={!t.aktiv && aktive >= MAX_AKTIV ? `Höchstens ${MAX_AKTIV} aktive Themen` : undefined}>
                    <input type="checkbox" checked={t.aktiv} disabled={!t.aktiv && aktive >= MAX_AKTIV} onChange={(e) => void speichern({ id: t.id, name: t.name, beschreibung: t.beschreibung, warum: t.warum, begriffe: t.begriffe.filter((b) => b.quelle === "nutzer").map((b) => b.text), aktiv: e.target.checked })} />
                    <span>aktiv</span>
                  </label>
                </div>
                {t.beschreibung && <p className="muted small" style={{ margin: "4px 0" }}>{t.beschreibung}</p>}
                {t.warum && <p className="muted small" style={{ margin: "4px 0" }}>Wozu: {t.warum}</p>}
                <ul className="chips" style={{ marginTop: 6 }}>
                  {t.begriffe.map((b) => (
                    <li key={b.text} className="chip" title={b.quelle === "ava" ? "von AVA ergänzt" : "von dir"} style={b.quelle === "ava" ? { opacity: 0.8 } : undefined}>
                      {b.text}
                    </li>
                  ))}
                  {t.begriffe.length === 0 && <li className="muted small">noch keine Begriffe</li>}
                </ul>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button type="button" onClick={() => setOffen(t.id)}>Bearbeiten</button>
                  <button type="button" onClick={() => void ergaenzen(t.id)} disabled={laeuft === t.id} title="Synonyme, Schreibweisen und englische Entsprechungen mit dem Hintergrund-Modell ergänzen">
                    {laeuft === t.id ? "Ergänzt…" : "Begriffe ergänzen lassen"}
                  </button>
                  <button type="button" className="link" onClick={() => void window.api.themen.remove(t.id).then(laden)}>Löschen</button>
                </div>
              </>
            )}
          </li>
        ))}
        {offen === "neu" && (
          <li className="panel" style={{ marginBottom: 10, padding: 12 }}>
            <ThemaFormular onAbbruch={() => setOffen(null)} onSpeichern={(e) => speichern(e)} />
          </li>
        )}
      </ul>
      {offen !== "neu" && (
        <button type="button" onClick={() => setOffen("neu")}>
          + Thema anlegen
        </button>
      )}
    </section>
  );
}

function ThemaFormular({ thema, onAbbruch, onSpeichern }: { thema?: Thema; onAbbruch: () => void; onSpeichern: (e: { name: string; beschreibung: string; warum: string; begriffe: string[]; aktiv?: boolean }) => void }) {
  const [name, setName] = useState(thema?.name ?? "");
  const [beschreibung, setBeschreibung] = useState(thema?.beschreibung ?? "");
  const [warum, setWarum] = useState(thema?.warum ?? "");
  const [begriffe, setBegriffe] = useState((thema?.begriffe ?? []).filter((b) => b.quelle === "nutzer").map((b) => b.text).join(", "));
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label>
        <span className="small">Name</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Betriebliche Altersvorsorge" maxLength={80} style={{ width: "100%" }} />
      </label>
      <label>
        <span className="small">Was ist gemeint?</span>
        <input type="text" value={beschreibung} onChange={(e) => setBeschreibung(e.target.value)} placeholder="Die Firma bietet ihren Beschäftigten eine betriebliche Altersvorsorge an" maxLength={300} style={{ width: "100%" }} />
      </label>
      <label>
        <span className="small">Wozu brauchst du das?</span>
        <input type="text" value={warum} onChange={(e) => setWarum(e.target.value)} placeholder="Wir beraten zu bAV; Firmen mit bestehendem Angebot sind Wechselkandidaten" maxLength={300} style={{ width: "100%" }} />
      </label>
      <label>
        <span className="small">Eigene Suchbegriffe (durch Komma getrennt)</span>
        <input type="text" value={begriffe} onChange={(e) => setBegriffe(e.target.value)} placeholder="Altersvorsorge, bAV, Pensionskasse" style={{ width: "100%" }} />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" disabled={!name.trim()} onClick={() => onSpeichern({ name: name.trim(), beschreibung: beschreibung.trim(), warum: warum.trim(), begriffe: begriffe.split(",").map((s) => s.trim()).filter(Boolean) })}>
          Speichern
        </button>
        <button type="button" className="link" onClick={onAbbruch}>Abbrechen</button>
      </div>
    </div>
  );
}
