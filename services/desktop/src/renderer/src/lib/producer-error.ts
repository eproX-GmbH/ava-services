// v0.1.218 — Producer-Fehler in strukturierte Kategorien klassifizieren.
//
// Producer-Supervisor setzt `errorMessage` als freien Text:
//   - "vendored dir not found"
//   - "nicht angemeldet oder kein LLM-Provider konfiguriert"
//   - "producer entry missing: …"
//   - "spawn failed: ENOENT"
//   - "failed to launch <name>: …"
//   - "AMQP connection lost: …" (subprocess stdout-detected)
//   - "Invalid authentication credentials" (subprocess stdout)
//
// Diese Wand hilft Nutzern nicht. Wir klassifizieren in eine Handvoll
// Kategorien und geben jedem Bucket einen konkreten Aktions-Hinweis.

export type ProducerErrorCategory =
  | "auth"
  | "binary"
  | "spawn"
  | "amqp"
  | "database"
  | "quota"
  | "unknown";

export interface HumanizedProducerError {
  category: ProducerErrorCategory;
  /** 1 Satz, auf Deutsch. */
  friendly: string;
  /** Was der Nutzer als nächstes tun kann. Optional — bei unknown
   *  haben wir oft nichts Sinnvolles zu sagen. */
  hint?: string;
  /** Ist das transient (Producer kommt vermutlich von alleine
   *  zurück) oder strukturell (Nutzer muss eingreifen)? */
  transient: boolean;
}

export function classifyProducerError(
  raw: string | null,
): HumanizedProducerError | null {
  if (!raw || raw.trim().length === 0) return null;
  const lower = raw.toLowerCase();

  // 1) Auth / Anmeldung / LLM-Config.
  if (
    lower.includes("nicht angemeldet") ||
    lower.includes("kein llm-provider") ||
    lower.includes("invalid authentication") ||
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("api key") ||
    lower.includes("api-key")
  ) {
    return {
      category: "auth",
      friendly:
        "Anmeldung oder LLM-Konfiguration fehlt — der Producer kann ohne gültige Credentials nicht starten.",
      hint: "Einstellungen → Modelle prüfen (API-Key / Pro-Abo / Provider-Auswahl).",
      transient: false,
    };
  }

  // 2) Binary / Vendoring fehlt.
  if (
    lower.includes("vendored dir not found") ||
    lower.includes("producer entry missing") ||
    lower.includes("enoent")
  ) {
    return {
      category: "binary",
      friendly:
        "Producer-Binary fehlt — vermutlich ist die App-Installation unvollständig.",
      hint: "App neu installieren oder im System-Tab den Producer-Sweep anstoßen.",
      transient: false,
    };
  }

  // 3) Spawn / Launch-Pfad.
  if (
    lower.includes("spawn failed") ||
    lower.includes("failed to launch") ||
    lower.includes("exit code")
  ) {
    return {
      category: "spawn",
      friendly:
        "Producer-Subprozess konnte nicht starten oder ist sofort abgestürzt.",
      hint: "App-Neustart probieren. Wenn das nicht hilft: System → Logs prüfen und Bug melden.",
      transient: true,
    };
  }

  // 4) AMQP / Cloud-Broker.
  if (
    lower.includes("amqp") ||
    lower.includes("rabbit") ||
    lower.includes("broker")
  ) {
    return {
      category: "amqp",
      friendly:
        "Verbindung zum Cloud-Broker (AMQP) verloren — Producer wartet auf erneute Verbindung.",
      hint: "Internetverbindung prüfen. Wenn dauerhaft: Status-Seite oder Support kontaktieren.",
      transient: true,
    };
  }

  // 5) Lokale Datenbank.
  if (
    lower.includes("postgres") ||
    lower.includes("database") ||
    lower.includes("econnrefused") ||
    lower.includes("port 5432")
  ) {
    return {
      category: "database",
      friendly:
        "Lokale Datenbank nicht erreichbar — Producer kann keine Daten persistieren.",
      hint: "Einstellungen → System → Lokale Datenbank: Status prüfen, ggf. neu starten.",
      transient: true,
    };
  }

  // 6) Quota / Rate-Limit / Billing.
  if (
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("insufficient_quota") ||
    lower.includes("billing") ||
    lower.includes("payment")
  ) {
    return {
      category: "quota",
      friendly:
        "API-Quota oder Rate-Limit beim LLM-Anbieter erreicht — Producer pausiert vorübergehend.",
      hint: "Bei Anthropic: Pro/Max-Abo prüfen oder Tier hochstufen. Bei OpenAI: Guthaben aufladen.",
      transient: true,
    };
  }

  // Fallback.
  return {
    category: "unknown",
    friendly: `Producer-Fehler: ${shorten(raw, 140)}`,
    transient: false,
  };
}

function shorten(s: string, max: number): string {
  const firstLine = s.split(/\r?\n/)[0]?.trim() ?? s.trim();
  return firstLine.length > max ? firstLine.slice(0, max - 1) + "…" : firstLine;
}
