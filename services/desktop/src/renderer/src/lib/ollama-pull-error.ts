// v0.1.220 — Ollama-Pull-Fehler in lesbare, actionable Hinweise
// umsetzen.
//
// Häufigster aktueller Fall: Nutzer hat eine zur Build-Zeit
// gebundelte alte Ollama-Binary (v0.3.x). Aktuelle Modelle (qwen3,
// gemma4) brauchen ≥ v0.5+. Ollama-Registry antwortet mit HTTP 412
// und einer Klartext-Meldung "requires a newer version of Ollama".
//
// Der Renderer rendert (a) den humanisierten Satz, (b) bei
// erkannter Update-Notwendigkeit einen "Ollama aktualisieren"-Button
// der die Self-Update-IPC triggert.

export type OllamaPullErrorCategory =
  | "version-mismatch"
  | "network"
  | "disk-full"
  | "model-not-found"
  | "auth"
  | "unknown";

export interface HumanizedOllamaPullError {
  category: OllamaPullErrorCategory;
  friendly: string;
  /** Optional kurzer Tipp für den nächsten Schritt. */
  hint?: string;
  /** Auf true bei Fällen, wo wir einen UI-Button anbieten sollten. */
  actionable: boolean;
}

export function classifyOllamaPullError(
  raw: string | null | undefined,
): HumanizedOllamaPullError | null {
  if (!raw || raw.trim().length === 0) return null;
  const lower = raw.toLowerCase();

  // 1) Version-Mismatch (Hauptfall).
  if (
    lower.includes("requires a newer version of ollama") ||
    (lower.includes("412") && lower.includes("manifest"))
  ) {
    return {
      category: "version-mismatch",
      friendly:
        "Das gewählte Modell verlangt eine neuere Ollama-Version als bei AVA gebündelt ist.",
      hint:
        'Klick auf "Ollama jetzt aktualisieren" — wir laden die aktuelle Version lokal nach (ohne App-Neustart).',
      actionable: true,
    };
  }

  // 2) Netzwerk.
  if (
    lower.includes("enotfound") ||
    lower.includes("getaddrinfo") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("network")
  ) {
    return {
      category: "network",
      friendly:
        "Ollama konnte den Modell-Registry-Server nicht erreichen — Netzwerkproblem.",
      hint: "Internetverbindung prüfen und erneut versuchen.",
      actionable: false,
    };
  }
  if (lower.includes("etimedout") || lower.includes("timeout")) {
    return {
      category: "network",
      friendly:
        "Ollama-Registry hat zu lange gebraucht. Versuch es in ein paar Minuten erneut.",
      actionable: false,
    };
  }

  // 3) Festplatte voll.
  if (lower.includes("enospc") || lower.includes("no space")) {
    return {
      category: "disk-full",
      friendly:
        "Auf der Festplatte ist nicht genug Platz für das Modell.",
      hint: "Ein paar GB freigeben und erneut versuchen.",
      actionable: false,
    };
  }

  // 4) Modell existiert nicht.
  if (
    lower.includes("model.*not found") ||
    lower.includes("no such model") ||
    lower.includes("404")
  ) {
    return {
      category: "model-not-found",
      friendly:
        "Modell wurde im Ollama-Registry nicht gefunden — der Modell-Name könnte sich geändert haben.",
      hint: "In den Einstellungen ein anderes Modell wählen.",
      actionable: false,
    };
  }

  // 5) Auth (selten bei Ollama-Public-Registry, aber Custom-Endpoints).
  if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication")
  ) {
    return {
      category: "auth",
      friendly: "Authentifizierung gegen die Modell-Registry fehlgeschlagen.",
      actionable: false,
    };
  }

  // Fallback: erste Zeile zeigen.
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? raw.trim();
  const trimmed =
    firstLine.length > 200 ? firstLine.slice(0, 197) + "…" : firstLine;
  return {
    category: "unknown",
    friendly: `Ollama-Download fehlgeschlagen: ${trimmed}`,
    actionable: false,
  };
}
