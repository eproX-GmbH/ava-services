import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { gatewayUpload, GatewayError } from "../api/gateway";

// W1 — Upload company Excel.
//
// Hits POST /v1/imports/excel (multipart). The query params describe how to
// read the sheet — which column heading is the company name (repeatable),
// which is the city, optional friendly name, and whether to fall back to
// fuzzy matching for unresolved rows. Defaults match what the legacy
// data-care UI sent for German company sheets.
//
// On success the gateway returns { transactionId }; we navigate straight to
// the live stream so the user sees the pipeline turn over in real time.

export function Ingest() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [companyHeader, setCompanyHeader] = useState("company");
  const [cityHeader, setCityHeader] = useState("city");
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
            companyNameIdentifiers: [companyHeader],
            city: cityHeader,
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
        <label className="field">
          <span>Company-name column heading</span>
          <input
            type="text"
            value={companyHeader}
            onChange={(e) => setCompanyHeader(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>City column heading</span>
          <input
            type="text"
            value={cityHeader}
            onChange={(e) => setCityHeader(e.target.value)}
            required
          />
        </label>
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
