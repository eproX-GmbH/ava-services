// v0.1.409 — Fester Willkommens-/Überblickstext.
//
// Schreibt ein Nutzer ganz am Anfang nur „Hi" oder fragt „Was kannst du?",
// antworten wir mit diesem festen Text — 1:1, OHNE LLM-Aufruf. Das spart
// KI-Kosten, garantiert eine immer gleiche, vollständige Antwort und
// verhindert, dass das Modell Funktionen halluziniert, die es nicht gibt.
// Inhalt bewusst an den real ausgelieferten Funktionen orientiert.

/** v0.1.742 (2026-10-03) — Willkommenstext nach Vorgabe des Operators
 *  (sieben Faehigkeitsbloecke). Vorher v0.1.646. Fester Text, keine
 *  KI; die Tool-Zahl kommt aus der Registry. Jede Aussage entspricht dem
 *  Website-Stand (docs/WEBSITE_PROMPT_*), nichts Geplantes. */
export function welcomeMessage(toolCount: number): string {
  const tools = toolCount > 0 ? `${Math.floor(toolCount / 10) * 10}+ Werkzeuge` : "viele Werkzeuge";
  return `Hi, ich bin **AVA**, deine Assistentin für B2B-Vertrieb und Recherche im DACH-Raum. 👋

Ich nehme dir die Fleißarbeit ab. Ein Überblick, was ich für dich tun kann:

**🔎 Recherchieren**
- Firmen automatisch recherchieren
- Unternehmensdaten und Ansprechpartner finden
- Firmenwissen direkt per Chat abfragen
- Informationen aus verschiedenen Quellen zusammenführen

**🎯 Neue Kunden finden**
- Passende Zielkunden identifizieren
- Ähnliche Unternehmen zu bestehenden Kunden finden
- Wunschkunden nach Region und Kriterien suchen
- Neue Vertriebschancen entdecken

**📡 Kunden beobachten**
- Kunden und Leads laufend überwachen
- Relevante Veränderungen frühzeitig erkennen
- Wachstum, Wechsel und neue Aktivitäten erkennen
- LinkedIn auf Verkaufssignale prüfen

**⚡ Chancen priorisieren**
- Vertriebssignale automatisch bewerten
- Interessante Accounts priorisieren
- Relevante Ereignisse hervorheben
- Konkrete nächste Schritte ableiten

**🤝 Gespräche vorbereiten**
- Kundentermine automatisch vorbereiten
- Aktuelle Firmenentwicklungen zusammenfassen
- Ansprechpartner und Kontext bereitstellen
- Gesprächsanlässe und Chancen aufzeigen

**⚙️ Vertriebsarbeit automatisieren**
- Wiederkehrende Workflows automatisieren
- CRM-Daten ergänzen und aktualisieren
- Recherche automatisch dokumentieren
- Aufgaben und Folgeaktionen auslösen

**✉️ Kommunikation vorbereiten**
- Personalisierte E-Mail-Entwürfe erstellen
- Nachrichten auf Basis des Kundenkontexts vorbereiten
- Relevante Updates und Chancen melden
- Ergebnisse direkt an den Vertrieb weitergeben

Dahinter stehen ${tools}, die ich in einem Chat kombiniere, dazu **Skills** als wiederverwendbare Routinen per Slash-Befehl. Deine Chats, Schlüssel und Logins bleiben auf deinem Rechner.

Unten habe ich dir passende nächste Schritte vorbereitet. Oder sag mir einfach, woran du arbeitest.`;
}

/** @deprecated Nur noch fuer Tests/Alt-Aufrufer; der Orchestrator nutzt welcomeMessage(). */
export const WELCOME_MESSAGE = welcomeMessage(0);

/**
 * Erkennt eine bloße Begrüßung oder eine „Was kannst du?"-Frage. Bewusst
 * eng gehalten (kurze Nachrichten, feste Muster), damit echte Aufgaben —
 * auch wenn sie mit „Hi, …" beginnen — NICHT fälschlich abgefangen werden.
 */
export function isWelcomeTrigger(raw: string): boolean {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[!?.,;:@_*]+/g, " ")
    .replace(/[\p{Extended_Pictographic}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return false;
  const wordCount = s.split(" ").length;

  // Exakte Kurz-Nachrichten (die GANZE Nachricht ist die Begrüßung/Frage).
  const EXACT = new Set([
    "hi", "hallo", "hey", "moin", "servus", "yo", "na", "hej", "hello",
    "hi ava", "hallo ava", "hey ava", "moin ava", "na ava",
    "guten tag", "guten morgen", "guten abend", "grüß dich", "grüß gott",
    "hallöchen", "na du", "hilfe", "help", "funktionen", "features",
    "was kannst du", "was kannst du alles", "was kannst du so",
    "was kannst du eigentlich", "was machst du", "was macht ava",
    "wer bist du", "was bist du", "was kann ava", "was bietest du",
    "what can you do", "who are you", "what do you do",
  ]);
  if (EXACT.has(s)) return true;

  // Sehr kurze Nachrichten (≤ 4 Wörter), die MIT einer Fähigkeits-/
  // Vorstell-Frage BEGINNEN. Bewusst per startsWith + niedrigem Wort-Cap,
  // damit echte Fragen wie „Was kannst du mir über SAP sagen?" NICHT
  // fälschlich abgefangen werden.
  if (wordCount <= 4) {
    const PREFIXES = [
      "was kannst du",
      "wobei kannst du",
      "womit kannst du",
      "wie kannst du",
      "stell dich vor",
      "erklär dich",
      "what can you do",
      "who are you",
    ];
    if (PREFIXES.some((p) => s.startsWith(p))) return true;
  }
  return false;
}
