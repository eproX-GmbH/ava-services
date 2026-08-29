// v0.1.409 — Fester Willkommens-/Überblickstext.
//
// Schreibt ein Nutzer ganz am Anfang nur „Hi" oder fragt „Was kannst du?",
// antworten wir mit diesem festen Text — 1:1, OHNE LLM-Aufruf. Das spart
// KI-Kosten, garantiert eine immer gleiche, vollständige Antwort und
// verhindert, dass das Modell Funktionen halluziniert, die es nicht gibt.
// Inhalt bewusst an den real ausgelieferten Funktionen orientiert.

export const WELCOME_MESSAGE = `Hi, ich bin **AVA** — deine persönliche Sales-Assistentin. 👋

Ich helfe dir, Vertrieb und Recherche im B2B von der lästigen Fleißarbeit zu befreien. Ein Überblick, was ich für dich tun kann:

**🔎 Recherche & Analyse**
- Firmen aus ihrer Live-Website + Handelsregister-Daten profilieren
- Zu einer Anfrage (RFQ) eine gerankte Best-Match-Firmenliste erstellen
- Excel-Listen importieren und automatisch anreichern

**🤝 CRM & Wissensquellen**
- **HubSpot** live: Firmen, Kontakte, Deals, Aufgaben & Notizen lesen, anlegen, aktualisieren, verknüpfen (mit Rückfrage vor jeder Änderung)
- **Notion** & **Obsidian**: Datenbanken/Notizen lesen und pflegen
- Daten zwischen den Systemen hin- und herbewegen

**📡 Monitoring & Signale**
- **LinkedIn-Signale**: ich beobachte Feeds und erkenne Ereignisse wie Finanzierungsrunden, Führungswechsel oder Einstellungswellen — du gibst 👍/👎, ich kalibriere mich auf das, was für dich zählt
- **Link-/Website-Überwachung**: ich behalte eine beliebige URL im Auge und melde mich, wenn sich etwas ändert
- **Mail-Triage**: ich sortiere und bearbeite eingehende E-Mails vor

**🛠️ Tools & Skills**
- Über 160 Werkzeuge, die ich in einem Chat kombinieren kann (Firmen, CRM, LinkedIn, Finanzdaten, Erinnerungen …)
- **Skills** = wiederverwendbare Vertriebs-Routinen, die du per Slash-Befehl auslöst — und **du kannst dir eigene Skills anlegen**
- **Automatisierungen**: geplante Aufgaben und Watches, die im Hintergrund laufen

**🔒 Lokal & privat**
- Deine Berechnung läuft auf deiner Maschine. Du wählst deinen KI-Anbieter oder ein lokales Modell — deine Daten bleiben bei dir.

Damit ich dich gezielt unterstützen kann, lass uns kurz dein **Idealkundenprofil (ICP)** festhalten: **Welche Firmen sind für dich die perfekten Kunden?** Beschreib mir gern Branche, Größe, Region und was eine Firma zu einem guten Lead macht.

Noch schneller: Nenn mir einfach **deine Website-URL und die Websites deiner besten Kunden** — ich lese daraus dein Angebot, deinen Standort und was deine Top-Kunden gemeinsam haben, und erstelle dein ICP selbst (auch als Assistent unter Firmen → Radar → „ICP bearbeiten"). Oder frag mich einfach direkt etwas.`;

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
