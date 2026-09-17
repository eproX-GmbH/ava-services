// Filter auf das Gruendungsjahr der Firma. Das Jahr stammt aus dem
// strukturierten Registerinhalt des Handelsregisters und ist deshalb nur fuer
// Firmen bekannt, die schon einmal abgerufen wurden. Sobald hier etwas gesetzt
// ist, zeigt die Liste ausschliesslich Firmen mit bekanntem Gruendungsjahr.

export type GruendungsSortierung = "" | "gruendung_auf" | "gruendung_ab";

export type GruendungsWerte = {
  von: string;
  bis: string;
  sortierung: GruendungsSortierung;
};

export const GRUENDUNG_LEER: GruendungsWerte = { von: "", bis: "", sortierung: "" };

export function gruendungAktiv(w: GruendungsWerte): boolean {
  return w.von !== "" || w.bis !== "" || w.sortierung !== "";
}

/** Nur gueltige Jahreszahlen an das Gateway geben; leere Felder bleiben weg. */
export function gruendungAlsQuery(w: GruendungsWerte): Record<string, string> {
  const q: Record<string, string> = {};
  const jahr = (s: string) => {
    const n = Number(s);
    return Number.isInteger(n) && n >= 1000 && n <= 2100 ? String(n) : null;
  };
  const von = jahr(w.von);
  const bis = jahr(w.bis);
  if (von) q.gruendungVon = von;
  if (bis) q.gruendungBis = bis;
  if (w.sortierung) q.sortierung = w.sortierung;
  return q;
}

export function GruendungsjahrFilter({
  werte,
  onChange,
}: {
  werte: GruendungsWerte;
  onChange: (w: GruendungsWerte) => void;
}) {
  const ungueltig = werte.von !== "" && werte.bis !== "" && Number(werte.von) > Number(werte.bis);
  return (
    <div className="gruendung-filter">
      <label className="gruendung-filter__label" htmlFor="gruendung-von">
        Gründungsjahr
      </label>
      <input
        id="gruendung-von"
        type="number"
        inputMode="numeric"
        min={1000}
        max={2100}
        placeholder="von"
        value={werte.von}
        aria-label="Gründungsjahr von"
        className="gruendung-filter__jahr"
        onChange={(e) => onChange({ ...werte, von: e.target.value })}
      />
      <span className="gruendung-filter__bis">bis</span>
      <input
        id="gruendung-bis"
        type="number"
        inputMode="numeric"
        min={1000}
        max={2100}
        placeholder="bis"
        value={werte.bis}
        aria-label="Gründungsjahr bis"
        className="gruendung-filter__jahr"
        onChange={(e) => onChange({ ...werte, bis: e.target.value })}
      />
      <select
        value={werte.sortierung}
        aria-label="Sortierung nach Gründungsjahr"
        title="Nach Gründungsjahr sortieren"
        className="gruendung-filter__sortierung"
        onChange={(e) => onChange({ ...werte, sortierung: e.target.value as GruendungsSortierung })}
      >
        <option value="">Sortierung: Name</option>
        <option value="gruendung_auf">Älteste zuerst</option>
        <option value="gruendung_ab">Jüngste zuerst</option>
      </select>
      {gruendungAktiv(werte) && (
        <button type="button" className="gruendung-filter__zuruecksetzen" onClick={() => onChange(GRUENDUNG_LEER)}>
          Filter zurücksetzen
        </button>
      )}
      {ungueltig && <span className="gruendung-filter__hinweis">Das Jahr „von" liegt nach „bis".</span>}
    </div>
  );
}
