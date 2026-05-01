import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { gatewayUpload, GatewayError } from "../api/gateway";

// W1 — Upload company Excel.
//
// Hits POST /v1/imports/excel (multipart). The query params describe how to
// read the sheet — which column heading(s) hold the company name, which
// hold the city/location, optional friendly name, and whether to fall back
// to fuzzy matching for unresolved rows.
//
// Both `companyNameIdentifiers` and `city` are repeatable: master-data
// concatenates the values of all listed columns with a single space, which
// is how sheets with split fields ("first name" + "last name", or "postal
// code" + "city") get joined into a single lookup string.
//
// On success the gateway returns { transactionId }; we navigate straight to
// the live stream so the user sees the pipeline turn over in real time.

export function Ingest() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [companyHeaders, setCompanyHeaders] = useState<string[]>(["company"]);
  const [cityHeaders, setCityHeaders] = useState<string[]>(["city"]);
  const [name, setName] = useState("");
  const [isFuzzy, setIsFuzzy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Bitte zuerst eine .xlsx-Datei auswählen.");
      return;
    }
    if (companyHeaders.length === 0) {
      setError("Mindestens eine Firmennamen-Spalte angeben.");
      return;
    }
    if (cityHeaders.length === 0) {
      setError("Mindestens eine Stadt-Spalte angeben.");
      return;
    }
    setBusy(true);
    setError(null);

    const form = new FormData();
    form.append("file", file);

    try {
      const { transactionId } = await gatewayUpload<{ transactionId: string }>(
        "/v1/imports/excel",
        form,
        {
          query: {
            companyNameIdentifiers: companyHeaders,
            city: cityHeaders,
            name: name || undefined,
            isFuzzy: String(isFuzzy),
          },
        },
      );
      navigate(`/transactions/${transactionId}/stream`);
    } catch (err) {
      const msg =
        err instanceof GatewayError
          ? `gateway ${err.status}: ${err.message}`
          : (err as Error).message;
      setError(msg);
      setBusy(false);
    }
  }

  return (
    <section className="ingest">
      <h2>Excel hochladen</h2>
      <p className="muted">
        Wähle eine .xlsx mit einer Zeile pro Firma. Die Pipeline gleicht jede
        Zeile gegen die Stammdaten ab und startet anschließend die
        Anreicherung über alle Dienste.
      </p>
      <form onSubmit={onSubmit} className="form">
        <label className="field">
          <span>Datei</span>
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>

        <ChipsField
          label="Firmennamen-Spalte(n)"
          hint="Eine oder mehrere Spaltenüberschriften eintragen. Mehrere Werte werden mit Leerzeichen verbunden (z. B. Vorname + Nachname)."
          values={companyHeaders}
          onChange={setCompanyHeaders}
          placeholder="company"
        />

        <ChipsField
          label="Stadt-Spalte(n)"
          hint="Eine oder mehrere Überschriften. Mehrere Werte werden mit Leerzeichen verbunden (z. B. PLZ + Ort)."
          values={cityHeaders}
          onChange={setCityHeaders}
          placeholder="city"
        />

        <label className="field">
          <span>Vorgangsname (optional)</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Q2-Akquise"
          />
        </label>
        <label className="field-inline">
          <input
            type="checkbox"
            checked={isFuzzy}
            onChange={(e) => setIsFuzzy(e.target.checked)}
          />
          <span>Fuzzy-Match für nicht aufgelöste Zeilen verwenden</span>
        </label>
        <button type="submit" disabled={busy || !file} className="primary">
          {busy ? "Wird hochgeladen…" : "Import starten"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  );
}

// Small chip-list input. Enter or comma commits the current draft; clicking
// × on a chip removes it. Kept inline rather than a shared component because
// this is the only multi-value input in the app right now — premature reuse.
interface ChipsFieldProps {
  label: string;
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}

function ChipsField({ label, hint, values, onChange, placeholder }: ChipsFieldProps) {
  const [draft, setDraft] = useState("");

  function commit() {
    const v = draft.trim();
    if (!v) return;
    if (values.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  }

  function remove(i: number) {
    onChange(values.filter((_, idx) => idx !== i));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
      // Quick "undo" — pop the last chip when backspacing into an empty input.
      onChange(values.slice(0, -1));
    }
  }

  return (
    <label className="field">
      <span>{label}</span>
      <div className="chips">
        {values.map((v, i) => (
          <span key={`${v}-${i}`} className="chip">
            {v}
            <button
              type="button"
              className="chip-remove"
              aria-label={`${v} entfernen`}
              onClick={() => remove(i)}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          className="chip-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
          placeholder={values.length === 0 ? placeholder : ""}
        />
      </div>
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}
