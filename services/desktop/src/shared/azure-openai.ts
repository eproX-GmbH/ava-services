// Azure OpenAI als Variante des OpenAI-Anbieters (v1-API, OpenAI-kompatibel):
// https://<ressource>.openai.azure.com/openai/v1/ mit dem Azure-Schlüssel.
// Modelle heißen dort wie die Deployments des Kunden; AVA rechnet intern
// weiter mit den Katalog-IDs (Kosten, Limits, Stufen) und übersetzt erst
// beim Aufruf. "*" = Deployment für alle Modelle ohne eigene Zuordnung.
// Gleiche Logik im Gateway: services/db-gateway/src/lib/azure-openai.ts.

export interface AzureOpenAIConfig {
  /** z. B. https://firma.openai.azure.com (ohne /openai/v1) */
  endpoint: string;
  /** Katalog-Modell-ID → Deployment-Name; "*" = alle übrigen */
  deployments: Record<string, string>;
}

const ERLAUBTE_HOSTS = /\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/i;

/** Normalisiert die Eingabe auf https://host (ohne Pfad); wirft bei fremden Adressen. */
export function azureEndpointNormalisieren(eingabe: string): string {
  const roh = eingabe.trim();
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(roh) ? roh : `https://${roh}`);
  } catch {
    throw new Error("Kein gültiger Azure-Endpunkt (erwartet z. B. https://firma.openai.azure.com).");
  }
  if (u.protocol !== "https:") throw new Error("Der Azure-Endpunkt muss mit https:// beginnen.");
  if (!ERLAUBTE_HOSTS.test(u.hostname)) {
    throw new Error("Der Endpunkt muss auf .openai.azure.com, .cognitiveservices.azure.com oder .services.ai.azure.com enden.");
  }
  return `https://${u.hostname.toLowerCase()}`;
}

/** Basis-URL der v1-API. */
export function azureBaseURL(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/openai/v1`;
}

/** Deployment-Namen erlauben Buchstaben, Ziffern, Punkt, Bindestrich, Unterstrich (Azure: max. 64). */
export function deploymentsNormalisieren(eingabe: Record<string, unknown> | null | undefined): Record<string, string> {
  const aus: Record<string, string> = {};
  for (const [modell, dep] of Object.entries(eingabe ?? {})) {
    const m = String(modell).trim();
    const d = typeof dep === "string" ? dep.trim() : "";
    if (!m || !d) continue;
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(d)) throw new Error(`Ungültiger Deployment-Name „${d}“.`);
    aus[m] = d;
  }
  return aus;
}

/** Deployment für ein Katalog-Modell; ohne Zuordnung das Modell selbst (Deployment gleich benannt). */
export function azureDeployment(cfg: Pick<AzureOpenAIConfig, "deployments">, modell: string): string {
  return cfg.deployments[modell] ?? cfg.deployments["*"] ?? modell;
}
