// Konto loeschen / deaktivieren (docs/PLAN_KONTO_LOESCHEN.md, Joyce 2026-11-08).
// Bewusst dezent: kleiner grauer Link ganz unten in Einstellungen → Konto, kein roter
// Knopf. Der Link klappt eine Pruefung auf (GET /v1/konto/loeschen) und zeigt genau
// einen Fall: Enterprise → AVA-Team; einziger Owner → erst Inhaberschaft uebertragen;
// allein in der Organisation → deaktivieren; sonst loeschen. Bestaetigung per Wort.
import { useState } from "react";
import { gatewayFetch } from "../../api/gateway";
import { problemMeldenOeffnen } from "../../components/ProblemMeldenDialog";

type Pruefung =
  | { moeglich: true; organisation: string | null; abo: { endetAm: string | null; bereitsGekuendigt: boolean } | null }
  | { moeglich: false; grund: "allein_in_organisation"; organisation: string | null; mitglieder: number; abo: { endetAm: string | null; bereitsGekuendigt: boolean } | null }
  | { moeglich: false; grund: "einziger_owner" | "enterprise"; organisation: string | null; mitglieder: number };

const SUPPORT = "info@eprox-gmbh.de";

function datum(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" });
}

function AboHinweis({ abo }: { abo: { endetAm: string | null; bereitsGekuendigt: boolean } | null }) {
  if (!abo) return null;
  const bis = datum(abo.endetAm);
  return (
    <p className="muted small">
      Dein Abo endet zum Ende der laufenden Zahlungsperiode{bis ? ` (${bis})` : ""}. Die Zeit bis dahin ist bereits bezahlt, eine
      Erstattung gibt es nicht.
    </p>
  );
}

function AvaTeam({ titel }: { titel: string }) {
  return (
    <p className="muted small">
      <button
        type="button"
        className="link"
        onClick={() => problemMeldenOeffnen({ ansicht: "neu", vorgabe: { kategorie: "anmeldung", titel } })}
      >
        Problem melden
      </button>{" "}
      oder schreib an{" "}
      <button type="button" className="link" onClick={() => void window.api.shell.openExternal(`mailto:${SUPPORT}`)}>
        {SUPPORT}
      </button>
      .
    </p>
  );
}

export function KontoLoeschenSection() {
  const [offen, setOffen] = useState(false);
  const [pruefung, setPruefung] = useState<Pruefung | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [wort, setWort] = useState("");
  const [busy, setBusy] = useState(false);

  const oeffnen = async () => {
    setOffen(true);
    setFehler(null);
    setPruefung(null);
    try {
      setPruefung(await gatewayFetch<Pruefung>("/v1/konto/loeschen", { signal: AbortSignal.timeout(15_000) }));
    } catch (e) {
      setFehler(e instanceof Error ? e.message : String(e));
    }
  };

  const ausfuehren = async (art: "loeschen" | "deaktivieren") => {
    setBusy(true);
    setFehler(null);
    try {
      await gatewayFetch(`/v1/konto/${art}`, { method: "POST", body: { bestaetigung: art === "loeschen" ? "LÖSCHEN" : "DEAKTIVIEREN" } });
      // Lokalen Bereich dieses Kontos entfernen; das aktive Konto startet dafuer neu.
      const snap = await window.api.accounts.list();
      const sub = snap.identity?.sub ?? snap.active;
      if (sub) await window.api.accounts.nachLoeschungEntfernen(sub);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    // Zugeklappt bewusst ohne Karte: nur kleiner grauer Text unter dem letzten Abschnitt.
    <section className={offen ? "provider-section konto-loeschen" : "konto-loeschen"} id="konto-loeschen" style={offen ? undefined : { padding: "0.25rem 0.25rem 1rem" }}>
      {!offen ? (
        <p className="muted small" style={{ margin: 0 }}>
          <button type="button" className="link" style={{ color: "inherit", textDecoration: "none" }} onClick={() => void oeffnen()}>
            Konto löschen…
          </button>
        </p>
      ) : (
        <div className="konto-loeschen__panel">
          <h4 style={{ marginTop: 0 }}>Konto löschen</h4>
          {!pruefung && !fehler && <p className="muted small">Wird geprüft…</p>}
          {pruefung && !pruefung.moeglich && pruefung.grund === "enterprise" && (
            <>
              <p className="small">
                Dein Konto gehört zu einem Enterprise-Vertrag{pruefung.organisation ? ` (${pruefung.organisation})` : ""}. Löschen und
                Deaktivieren laufen dort über das AVA-Team, weil zum Beispiel ein eigener Server an deinem Konto hängen kann.
              </p>
              <AvaTeam titel="Konto löschen (Enterprise)" />
            </>
          )}
          {pruefung && !pruefung.moeglich && pruefung.grund === "einziger_owner" && (
            <>
              <p className="small">
                Du bist der einzige Owner von <strong>{pruefung.organisation ?? "deiner Organisation"}</strong>. Die Organisation braucht
                immer mindestens einen Owner. Ernenne in der AVA Konsole unter Mitglieder zuerst eine weitere Person zum Owner, dann
                kannst du dein Konto löschen.
              </p>
              <p className="small">
                <button type="button" className="link" onClick={() => void window.api.shell.openExternal("https://admin.ava.bi/mitglieder")}>
                  AVA Konsole öffnen
                </button>
              </p>
            </>
          )}
          {pruefung && !pruefung.moeglich && pruefung.grund === "allein_in_organisation" && (
            <>
              <p className="small">
                Du bist die einzige Person in <strong>{pruefung.organisation ?? "deiner Organisation"}</strong>. Ein Konto, an dem eine
                Organisation hängt, kann nicht gelöscht werden; dafür wende dich bitte an das AVA-Team.
              </p>
              <AvaTeam titel="Konto löschen (einzige Person in der Organisation)" />
              <p className="small">
                Du kannst dein Konto aber <strong>deaktivieren</strong>: Du kannst dich dann nicht mehr anmelden, deine Daten bleiben
                gespeichert, und nur das AVA-Team kann das Konto wieder einschalten.
              </p>
              <AboHinweis abo={pruefung.abo} />
              <p className="small">Zur Bestätigung tippe DEAKTIVIEREN ein.</p>
              <div style={{ display: "flex", gap: "0.5rem", maxWidth: 420 }}>
                <input type="text" value={wort} onChange={(e) => setWort(e.target.value)} placeholder="DEAKTIVIEREN" style={{ flex: 1 }} disabled={busy} />
                <button type="button" disabled={busy || wort.trim() !== "DEAKTIVIEREN"} onClick={() => void ausfuehren("deaktivieren")}>
                  {busy ? "Wird deaktiviert…" : "Konto deaktivieren"}
                </button>
              </div>
            </>
          )}
          {pruefung && pruefung.moeglich && (
            <>
              <p className="small">Das passiert, wenn du dein Konto löschst:</p>
              <ul className="small">
                <li>Name und E-Mail-Adresse werden unkenntlich gemacht, du kannst dich nicht mehr anmelden.</li>
                <li>Deine eigenen Daten werden gelöscht (zum Beispiel deine Firmenliste, Buying Center, Leads und Einstellungen).</li>
                {pruefung.organisation && <li>Du verlässt {pruefung.organisation}. Was du dort geteilt hast, bleibt ohne deinen Namen erhalten.</li>}
                <li>Rechnungen bewahren wir aus gesetzlichen Gründen auf, ohne deinen Namen in AVA.</li>
                <li>AVA entfernt dein Konto von diesem Rechner und startet neu.</li>
              </ul>
              <AboHinweis abo={pruefung.abo} />
              <p className="small">
                <strong>Das lässt sich nicht rückgängig machen.</strong> Zur Bestätigung tippe LÖSCHEN ein.
              </p>
              <div style={{ display: "flex", gap: "0.5rem", maxWidth: 420 }}>
                <input type="text" value={wort} onChange={(e) => setWort(e.target.value)} placeholder="LÖSCHEN" style={{ flex: 1 }} disabled={busy} />
                <button type="button" disabled={busy || wort.trim() !== "LÖSCHEN"} onClick={() => void ausfuehren("loeschen")}>
                  {busy ? "Wird gelöscht…" : "Konto endgültig löschen"}
                </button>
              </div>
            </>
          )}
          {fehler && <p className="bad small">{fehler}</p>}
          <p className="small" style={{ marginTop: "0.75rem" }}>
            <button type="button" className="link muted" onClick={() => { setOffen(false); setWort(""); }} disabled={busy}>
              Abbrechen
            </button>
          </p>
        </div>
      )}
    </section>
  );
}
