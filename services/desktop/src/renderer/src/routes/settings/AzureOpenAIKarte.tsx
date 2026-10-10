// Azure OpenAI für den eigenen OpenAI-Schlüssel (shared/azure-openai.ts):
// Endpunkt der Azure-Ressource und Zuordnung Modell → Deployment. Der
// Schlüssel darüber ist dann der Azure-Schlüssel; Chat, Hintergrund-
// Verarbeitung, Recherche und Telegram laufen über die Azure-Ressource.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ProviderConfigBundle } from "../../../../shared/types";

interface Zeile {
  modell: string;
  deployment: string;
}

const ALLE = "*";

function startZeilen(b: ProviderConfigBundle | undefined): Zeile[] {
  const cfg = b?.config;
  const dep = cfg?.openaiAzure?.deployments ?? {};
  const modelle = [cfg?.models.openai, cfg?.producerModels?.openai].filter((m): m is string => Boolean(m && m.trim()));
  const zeilen: Zeile[] = [];
  for (const m of [...new Set([...modelle, ...Object.keys(dep).filter((k) => k !== ALLE)])]) zeilen.push({ modell: m, deployment: dep[m] ?? "" });
  zeilen.push({ modell: ALLE, deployment: dep[ALLE] ?? "" });
  return zeilen;
}

export function AzureOpenAIKarte() {
  const qc = useQueryClient();
  const bundle = useQuery<ProviderConfigBundle>({ queryKey: ["agent", "providerConfig"], queryFn: () => window.api.agent.getProviderConfig() });
  const aktuell = bundle.data?.config.openaiAzure ?? null;
  const [an, setAn] = useState<boolean>(Boolean(aktuell));
  const [endpunkt, setEndpunkt] = useState(aktuell?.endpoint ?? "");
  const [zeilen, setZeilen] = useState<Zeile[]>(() => startZeilen(bundle.data));
  const [pruefung, setPruefung] = useState<string | null>(null);

  const neuLaden = () => qc.invalidateQueries({ queryKey: ["agent", "providerConfig"] });
  const speichern = useMutation({
    mutationFn: () => {
      const deployments: Record<string, string> = {};
      for (const z of zeilen) if (z.modell.trim() && z.deployment.trim()) deployments[z.modell.trim()] = z.deployment.trim();
      return window.api.agent.setAzureConfig({ endpoint: endpunkt, deployments });
    },
    onSuccess: (neu) => {
      setPruefung(null);
      if (neu) setEndpunkt(neu.endpoint);
      void neuLaden();
    },
  });
  const ausschalten = useMutation({
    mutationFn: () => window.api.agent.setAzureConfig(null),
    onSuccess: () => {
      setAn(false);
      setPruefung(null);
      void neuLaden();
    },
  });
  const pruefen = useMutation({
    mutationFn: () => window.api.agent.azurePruefen(),
    onSuccess: (r) => setPruefung(r.ok ? "Verbindung zu Azure OpenAI steht." : r.reason),
  });

  const setZeile = (i: number, teil: Partial<Zeile>) => setZeilen(zeilen.map((z, j) => (j === i ? { ...z, ...teil } : z)));

  return (
    <div className="provider-key-card__azure" style={{ marginTop: "0.75rem", display: "grid", gap: "0.5rem" }}>
      <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
        <input
          type="checkbox"
          checked={an}
          onChange={(e) => {
            if (e.target.checked) setAn(true);
            else if (aktuell) ausschalten.mutate();
            else setAn(false);
          }}
          disabled={ausschalten.isPending}
        />
        Über Azure OpenAI (eigene Azure-Ressource)
      </label>
      {an && (
        <>
          <p className="provider-key-card__description">
            Der Schlüssel oben ist dann der Schlüssel deiner Azure-OpenAI-Ressource. Trage die Deployments ein, unter denen
            die Modelle dort laufen; ohne Eintrag nutzt AVA ein gleichnamiges Deployment. Der Sprachmodus braucht weiterhin
            einen Schlüssel direkt bei OpenAI.
          </p>
          <label className="field">
            <span>Endpunkt</span>
            <input
              type="url"
              placeholder="https://firma.openai.azure.com"
              value={endpunkt}
              onChange={(e) => setEndpunkt(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <div style={{ display: "grid", gap: "0.35rem" }}>
            <span className="muted small">Modell → Deployment</span>
            {zeilen.map((z, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 5.5rem", gap: "0.4rem", alignItems: "center" }}>
                {z.modell === ALLE ? (
                  <span className="muted small">Alle übrigen Modelle</span>
                ) : (
                  <input type="text" value={z.modell} placeholder="Modell, z. B. gpt-5-mini" onChange={(e) => setZeile(i, { modell: e.target.value })} spellCheck={false} />
                )}
                <input type="text" value={z.deployment} placeholder={z.modell === ALLE ? "Deployment (optional)" : "Deployment-Name"} onChange={(e) => setZeile(i, { deployment: e.target.value })} spellCheck={false} />
                {z.modell === ALLE ? (
                  <span />
                ) : (
                  <button type="button" className="link" onClick={() => setZeilen(zeilen.filter((_, j) => j !== i))} title="Zuordnung entfernen">
                    entfernen
                  </button>
                )}
              </div>
            ))}
            <div>
              <button type="button" className="link" onClick={() => setZeilen([...zeilen.slice(0, -1), { modell: "", deployment: "" }, zeilen[zeilen.length - 1]!])}>
                + Zuordnung
              </button>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" onClick={() => speichern.mutate()} disabled={!endpunkt.trim() || speichern.isPending}>
              {speichern.isPending ? "Speichert…" : "Azure speichern"}
            </button>
            <button type="button" className="btn" onClick={() => pruefen.mutate()} disabled={!aktuell || pruefen.isPending}>
              {pruefen.isPending ? "Prüft…" : "Verbindung prüfen"}
            </button>
          </div>
          {speichern.error && <p className="provider-key-card__error">{(speichern.error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}</p>}
          {pruefung && <p className={pruefung.startsWith("Verbindung zu Azure") ? "muted small" : "provider-key-card__error"}>{pruefung}</p>}
        </>
      )}
    </div>
  );
}
