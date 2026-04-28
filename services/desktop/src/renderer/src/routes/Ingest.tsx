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
      setError("Pick an .xlsx file first.");
      return;
    }
    if (companyHeaders.length === 0) {
      setError("Add at least one company-name column.");
      return;
    }
    if (cityHeaders.length === 0) {
      setError("Add at least one city column.");
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
      <h2>Upload Excel</h2>
      <p className="muted">
        Pick an .xlsx with one row per company. The pipeline will resolve each
        row against master-data and start extraction across all enrichment
        services.
      </p>
      <form onSubmit={onSubmit} className="form">
        <label className="field">
          <span>File</span>
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>

        <ChipsField
          label="Company-name column heading(s)"
          hint="Add one or more column headings. Multiple values get joined with a space (e.g. first + last name)."
          values={companyHeaders}
          onChange={setCompanyHeaders}
          placeholder="company"
        />

        <ChipsField
          label="City column heading(s)"
          hint="Add one or more headings. Multiple values get joined with a space (e.g. postal code + city)."
          values={cityHeaders}
          onChange={setCityHeaders}
          placeholder="city"
        />

        <label className="field">
          <span>Transaction name (optional)</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Q2 outreach batch"
          />
        </label>
        <label className="field-inline">
          <input
            type="checkbox"
            checked={isFuzzy}
            onChange={(e) => setIsFuzzy(e.target.checked)}
          />
          <span>Fall back to fuzzy match for unresolved rows</span>
        </label>
        <button type="submit" disabled={busy || !file} className="primary">
          {busy ? "Uploading…" : "Start ingest"}
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
              aria-label={`Remove ${v}`}
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
