// v0.1.211 — Updater-Fehler in lesbare Meldungen übersetzen.
//
// `electron-updater` wirft sehr ausführliche Fehler — typisch ein
// kompletter HTTP-Header-Dump + Stack-Trace, oft mehrere KB. Im
// Settings-Tab und im UpdateBanner haben wir das bisher 1:1
// angezeigt → wand voller roter Text, der den eigentlichen Punkt
// versteckt.
//
// Diese Helper-Funktion klassifiziert die häufigsten Fälle und gibt
// einen kurzen deutschen Hinweis + (optional) den Roh-Text zum
// Aufklappen zurück. Unbekannte Fälle bekommen einen generischen
// Hinweis + Details-Toggle, damit Power-User trotzdem das Original
// einsehen können.

export interface HumanizedUpdaterError {
  /** 1-2 Sätze, auf Deutsch. Für die Hauptzeile. */
  friendly: string;
  /** Wenn der Fehler weiter analysiert werden soll: der Original-
   *  Fehlertext (gekürzt auf die ersten ~600 Zeichen). null wenn
   *  der friendly-Text schon alles sagt (z. B. "Build läuft noch"). */
  technical: string | null;
  /** Hinweis, ob es sich um einen "transienten" Zustand handelt
   *  (Build läuft noch, Netzwerk weg) bei dem ein erneuter Versuch
   *  in ein paar Minuten Sinn ergibt. UI rendert dann eher in
   *  Info-Farben statt Fehler-Rot. */
  transient: boolean;
}

export function humanizeUpdaterError(raw: string | null): HumanizedUpdaterError | null {
  if (!raw || raw.trim().length === 0) return null;
  const lower = raw.toLowerCase();

  // 1) latest-mac.yml fehlt → Build läuft noch oder ist gescheitert.
  //    Häufigster Fall: Nutzer klickt "Jetzt nach Updates suchen"
  //    während die CI das aktuelle Release noch hochlädt.
  if (
    lower.includes("latest-mac.yml") &&
    (lower.includes("404") || lower.includes("cannot find"))
  ) {
    return {
      friendly:
        "Ein neues Update wird gerade vorbereitet. Versuch es in ein paar Minuten erneut — der Build-Server ist noch nicht fertig.",
      technical: condense(raw),
      transient: true,
    };
  }

  // 2) Anderes 404 auf einer Release-URL (latest.yml etc.).
  if (lower.includes("404") && lower.includes("releases/download")) {
    return {
      friendly:
        "Der erwartete Release-Artefakt ist noch nicht verfügbar. Vermutlich läuft der Build noch — bitte in ein paar Minuten erneut versuchen.",
      technical: condense(raw),
      transient: true,
    };
  }

  // 3) Netzwerk-Klassiker.
  if (
    lower.includes("enotfound") ||
    lower.includes("getaddrinfo") ||
    lower.includes("dns")
  ) {
    return {
      friendly:
        "Konnte den Update-Server nicht erreichen (DNS-Auflösung fehlgeschlagen). Prüfe deine Internetverbindung.",
      technical: condense(raw),
      transient: true,
    };
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("network")
  ) {
    return {
      friendly:
        "Netzwerkproblem beim Update-Server. Versuch es in ein paar Minuten erneut.",
      technical: condense(raw),
      transient: true,
    };
  }
  if (lower.includes("etimedout") || lower.includes("timeout")) {
    return {
      friendly:
        "Der Update-Server hat zu lange gebraucht. Versuch es später erneut.",
      technical: condense(raw),
      transient: true,
    };
  }

  // 4) Signatur-/Integritätsprobleme — das ist NICHT transient,
  //    der Build oder die Verteilung ist defekt.
  if (
    lower.includes("sha512") ||
    lower.includes("checksum") ||
    lower.includes("signature")
  ) {
    return {
      friendly:
        "Update wurde heruntergeladen, aber die Signatur stimmt nicht. Lade die App bitte manuell neu von GitHub Releases.",
      technical: condense(raw),
      transient: false,
    };
  }

  // 5) Festplatte voll / Schreibrechte.
  if (
    lower.includes("enospc") ||
    lower.includes("disk full") ||
    lower.includes("no space")
  ) {
    return {
      friendly:
        "Auf der Festplatte ist nicht genug Platz für das Update. Bitte ein paar GB freigeben und erneut versuchen.",
      technical: condense(raw),
      transient: false,
    };
  }

  // 6) Fallback: erste Zeile zeigen, Rest hinter Details.
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? raw.trim();
  const trimmed =
    firstLine.length > 160 ? firstLine.slice(0, 157) + "…" : firstLine;
  return {
    friendly: `Update-Prüfung fehlgeschlagen: ${trimmed}`,
    technical: condense(raw),
    transient: false,
  };
}

/** Den Roh-Text auf eine vernünftige Länge kürzen und den HTTP-Header-
 *  Dump ausblenden — der ist immer dieselbe Wand und für niemanden
 *  hilfreich. */
function condense(raw: string): string {
  let s = raw;
  // electron-updater hängt oft einen ` Headers: { … }`-Block an,
  // der den Punkt verwässert. Abschneiden.
  const headersAt = s.indexOf(" Headers: {");
  if (headersAt > 0) s = s.slice(0, headersAt);
  // Auf 600 Zeichen kappen.
  if (s.length > 600) s = s.slice(0, 597) + "…";
  return s.trim();
}
