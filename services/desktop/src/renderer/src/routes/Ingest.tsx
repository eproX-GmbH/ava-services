import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { gatewayFetch, gatewayUpload, GatewayError } from "../api/gateway";
import { USAGE_QUERY_KEY, type UsageSnapshot } from "../api/usage";
import { parseAttachment } from "../lib/attachment";
import {
  ImportConfirmDialog,
  runImportWithSkipMode,
  type ImportConfirmChoice,
} from "../components/ImportConfirmDialog";
import { estimateImportCost } from "../../../shared/research-cost";
import type { ResearchSettingsBundle } from "../../../shared/types";

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
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [companyHeaders, setCompanyHeaders] = useState<string[]>(["company"]);
  const [cityHeaders, setCityHeaders] = useState<string[]>(["city"]);
  const [name, setName] = useState("");
  const [isFuzzy, setIsFuzzy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // M2 — quota_exceeded message from the gateway (or our client gate).
  // Rendered as an inline error block with an Upgrade CTA.
  const [quotaError, setQuotaError] = useState<{
    used: number;
    limit: number;
    needed: number;
    tier: string;
  } | null>(null);

  // v0.1.179 — Pre-import gate state. When the user submits and at
  // least one research feature is active, we show the confirm dialog
  // instead of POSTing immediately. The promise resolver lets us
  // `await` the user's choice from inside `onSubmit`.
  const [pendingConfirm, setPendingConfirm] = useState<{
    companyCount: number;
    bundle: ResearchSettingsBundle;
    blockSkip: boolean;
    resolve: (c: ImportConfirmChoice) => void;
  } | null>(null);

  function askForResearchConfirm(args: {
    companyCount: number;
    bundle: ResearchSettingsBundle;
    blockSkip: boolean;
  }): Promise<ImportConfirmChoice> {
    return new Promise((resolve) => {
      setPendingConfirm({ ...args, resolve });
    });
  }

  // Listen for the structured 402 dispatched from api/gateway.ts so any
  // import path (this form, future agent tools) surfaces a single
  // upgrade CTA. Locally-detected quota issues set the same state
  // synchronously below.
  useEffect(() => {
    function onQuota(ev: Event) {
      const detail = (ev as CustomEvent).detail as {
        used: number;
        limit: number;
        neededCount: number;
        tier: string;
      } | undefined;
      if (!detail) return;
      setQuotaError({
        used: detail.used,
        limit: detail.limit,
        needed: detail.neededCount,
        tier: detail.tier,
      });
    }
    window.addEventListener("ava:quota-exceeded", onQuota as EventListener);
    return () =>
      window.removeEventListener("ava:quota-exceeded", onQuota as EventListener);
  }, []);

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
    setQuotaError(null);

    // M2 — pre-import client gate. Parse the xlsx locally to count rows,
    // then read the cached usage snapshot. If the import would push past
    // the limit we refuse before the upload, saving the round-trip and
    // showing the German error message earlier than the gateway 402.
    let expectedCount = 0;
    try {
      const parsed = await parseAttachment(file);
      expectedCount = parsed.sheets.reduce((sum, s) => sum + s.totalRows, 0);
    } catch {
      // Fall through — the gateway / master-data will reject malformed
      // xlsx with its own 4xx and we'll surface that.
    }
    if (expectedCount > 0) {
      try {
        const snap = await queryClient.fetchQuery<UsageSnapshot>({
          queryKey: USAGE_QUERY_KEY,
          queryFn: () => gatewayFetch<UsageSnapshot>("/v1/usage"),
          staleTime: 30_000,
        });
        if (snap.limit !== -1 && snap.used + expectedCount > snap.limit) {
          setQuotaError({
            used: snap.used,
            limit: snap.limit,
            needed: expectedCount,
            tier: snap.tier,
          });
          setBusy(false);
          return;
        }
      } catch {
        // Snapshot fetch failed — fall through to the server gate.
      }
    }

    // v0.1.179 — Pre-import research gate. If at least one research
    // feature is active, show the confirmation modal. The user picks
    // mit/ohne/abbrechen; on "ohne" we route through skip-mode so
    // the producer cycles to tier=off before the actual POST.
    const researchBundle = await window.api.research.getBundle();
    const researchEstimate =
      expectedCount > 0
        ? estimateImportCost(researchBundle.config, expectedCount)
        : null;

    let useSkipMode = false;
    if (researchEstimate) {
      const blockSkip = (await window.api.research.hasPendingSkipMode()).pending;
      const choice = await askForResearchConfirm({
        companyCount: expectedCount,
        bundle: researchBundle,
        blockSkip,
      });
      setPendingConfirm(null);
      if (choice === "cancel") {
        setBusy(false);
        return;
      }
      useSkipMode = choice === "skip-research";
    }

    const form = new FormData();
    form.append("file", file);

    const doPost = (): Promise<{ transactionId: string }> =>
      gatewayUpload<{ transactionId: string }>("/v1/imports/excel", form, {
        query: {
          companyNameIdentifiers: companyHeaders,
          city: cityHeaders,
          name: name || undefined,
          isFuzzy: String(isFuzzy),
          ...(expectedCount > 0 ? { expectedCount: String(expectedCount) } : {}),
        },
        // Option D — BYO-key passthrough. Attach the user's active
        // provider key so master-data can forward it to the LLM
        // producers via AMQP headers. Producer falls back to env
        // when the user hasn't configured a provider yet.
        attachUserLlm: true,
      });

    try {
      const { transactionId } = useSkipMode
        ? await runImportWithSkipMode(doPost)
        : await doPost();
      navigate(`/transactions/${transactionId}/stream`);
    } catch (err) {
      // gateway.ts already dispatched `ava:quota-exceeded` for 402 — the
      // listener above set quotaError. Skip the generic error rendering
      // in that case.
      if (err instanceof GatewayError && err.status === 402) {
        setBusy(false);
        return;
      }
      const msg =
        err instanceof GatewayError
          ? `gateway ${err.status}: ${err.message}`
          : (err as Error).message;
      setError(msg);
      setBusy(false);
    }
  }

  return (
    <section className="ingest page">
      <header className="ct-page-header">
        <p className="ct-page-header__eyebrow">Daten-Import</p>
        <h2 className="ct-page-header__title">
          Excel <span className="ct-gradient-text">hochladen</span>
        </h2>
        <p className="ct-page-header__lede">
          Wähle eine .xlsx mit einer Zeile pro Firma. Die Pipeline gleicht
          jede Zeile gegen die Stammdaten ab und startet anschließend die
          Anreicherung über alle Dienste.
        </p>
      </header>
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
        {quotaError && (
          <div className="error" role="alert">
            <strong>Kontingent überschritten.</strong>{" "}
            Dieser Import würde {quotaError.needed}{" "}
            {quotaError.needed === 1 ? "Firma" : "Firmen"} hinzufügen, aber
            dein {quotaError.tier}-Tarif erlaubt nur {quotaError.limit} pro
            Zyklus (bereits {quotaError.used} verbraucht).{" "}
            <Link to="/settings#plan-section">In den Einstellungen upgraden →</Link>
          </div>
        )}
      </form>
      {/* v0.1.179 — Pre-import research-cost confirmation. Mounted
       *  conditionally; the resolver hooked in `askForResearchConfirm`
       *  awaits the user's button click. */}
      {pendingConfirm && (
        <ImportConfirmDialog
          companyCount={pendingConfirm.companyCount}
          bundle={pendingConfirm.bundle}
          blockSkip={pendingConfirm.blockSkip}
          onResolve={pendingConfirm.resolve}
        />
      )}
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
