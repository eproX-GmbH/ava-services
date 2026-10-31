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
        "Die Anmeldung beim KI-Anbieter fehlt oder ist abgelaufen. Ohne sie kann dieser Dienst nicht starten.",
      hint: "Unter Einstellungen → KI & Kosten den Anbieter und den Schlüssel prüfen.",
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
        "Ein Teil der Installation fehlt. Vermutlich wurde AVA nicht vollständig installiert.",
      hint: "AVA neu installieren. Hilft das nicht, den Support mit den technischen Details anschreiben.",
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
        "Dieser Dienst konnte nicht starten oder ist sofort abgestürzt.",
      hint: "AVA neu starten. Hilft das nicht, den Support mit den technischen Details anschreiben.",
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
        "Die Verbindung zum AVA-Server ist weg. Der Dienst wartet, bis sie wieder steht.",
      hint: "Internetverbindung prüfen. Bleibt es so, den Support anschreiben.",
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
        "Die Datenbank auf diesem Rechner ist nicht erreichbar. Der Dienst kann nichts speichern.",
      hint: "Unter Einstellungen → Erweitert den Zustand der Datenbank prüfen, notfalls AVA neu starten.",
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
        "Der KI-Anbieter nimmt gerade keine weiteren Anfragen an. Der Dienst pausiert vorübergehend.",
      hint: "Beim Anbieter das Guthaben oder die Grenzen des Kontos prüfen.",
      transient: true,
    };
  }

  // Fallback.
  return {
    category: "unknown",
    friendly: `Fehler im Dienst: ${shorten(raw, 140)}`,
    transient: false,
  };
}

function shorten(s: string, max: number): string {
  const firstLine = s.split(/\r?\n/)[0]?.trim() ?? s.trim();
  return firstLine.length > max ? firstLine.slice(0, max - 1) + "…" : firstLine;
}
