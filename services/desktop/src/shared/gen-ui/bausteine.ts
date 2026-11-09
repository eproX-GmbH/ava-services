// Generative UI (docs/PLAN_GENERATIVE_UI.md): Beschreibung der Bausteine als
// reine Daten, gemeinsam fuer den Systemprompt (Hauptprozess, ohne json-render)
// und den Katalog der Oberflaeche (renderer, zod-Schemas je Baustein). Keine
// Vorlagen je Anwendungsfall: das Modell waehlt anhand von "wofuer".

export interface BausteinText {
  /** Kurzform der Props fuer den Prompt. */
  props: string;
  /** Wofuer der Baustein da ist (ein, zwei Saetze). */
  wofuer: string;
  /** Nimmt Kinder auf (children). */
  kinder?: boolean;
  /** Benannte Zusatz-Slots neben children. */
  slots?: string[];
}

export const BAUSTEINE: Record<string, BausteinText> = {
  Karte: {
    props: "titel?: string, untertitel?: string",
    wofuer: "Rahmen um eine zusammengehörige Antwort, meist das Wurzelelement. Ein Knopf oben rechts kommt in den Slot \"aktion\" (z. B. Firma öffnen).",
    kinder: true,
    slots: ["aktion"],
  },
  Raster: {
    props: "spalten: 1 | 2 | 3 | 4",
    wofuer: "Ordnet Kinder nebeneinander, z. B. zwei Diagramme oder mehrere Firmenkarten. Bricht in schmalen Fenstern um.",
    kinder: true,
  },
  Abschnitt: {
    props: "titel?: string",
    wofuer: "Unterteilt eine Karte mit eigener Zwischenüberschrift.",
    kinder: true,
  },
  Text: {
    props: "inhalt: string, stil?: \"normal\" | \"gedaempft\"",
    wofuer: "Ein Absatz Fließtext, **fett** erlaubt. gedaempft für Fußnoten und Quellenhinweise.",
  },
  Hinweis: {
    props: "art: \"info\" | \"warnung\" | \"erfolg\", text: string",
    wofuer: "Hervorgehobene Einordnung, z. B. Insolvenz, fehlende Daten oder ein wichtiger Befund.",
  },
  Marke: {
    props: "text: string, ton?: \"neutral\" | \"gut\" | \"warnung\" | \"schlecht\" | \"marke\"",
    wofuer: "Kleines Etikett für Status, Kategorie oder Rechtsform.",
  },
  Kennzahlen: {
    props: "(keine)",
    wofuer: "Zeile aus 2 bis 6 Kennzahl-Kindern, die wichtigsten Werte zuerst. Steht meist oben in der Karte.",
    kinder: true,
  },
  Kennzahl: {
    props: "label: string, wert: string (fertig formatiert, z. B. \"4,2 Mio. €\"), veraenderung?: number (Prozent zum Vorwert, z. B. 18 oder -3,5), vergleich?: string (z. B. \"zu 2023\"), verlauf?: number[] (Mini-Verlauf, älteste zuerst)",
    wofuer: "Ein einzelner Wert mit optionaler Veränderung (grün/rot) und Mini-Verlauf.",
  },
  Verlauf: {
    props: "titel?: string, format: \"eur\" | \"int\" | \"num\" | \"pct\", reihen: { name: string, punkte: { x: string, y: number }[] }[], flaeche?: boolean",
    wofuer: "Entwicklung über viele Zeitpunkte (Monate, Quartale, mehr als 6 Jahre). Für wenige Jahre lieber Balken.",
  },
  Balken: {
    props: "titel?: string, format: \"eur\" | \"int\" | \"num\" | \"pct\", kategorien: string[], reihen: { name: string, werte: number[] }[]",
    wofuer: "Vergleich weniger Kategorien oder Jahre, z. B. Umsatz oder Mitarbeiter je Jahr, mehrere Reihen nebeneinander.",
  },
  Rangliste: {
    props: "titel?: string, format: \"eur\" | \"int\" | \"num\" | \"pct\", eintraege: { label: string, wert: number, hervorheben?: boolean, companyId?: string }[]",
    wofuer: "Sortierte Top-N als waagerechte Balken mit Wert, z. B. Umsatz je Region oder Firmen nach Score.",
  },
  Ring: {
    props: "titel?: string, format: \"eur\" | \"int\" | \"num\" | \"pct\", anteile: { label: string, wert: number }[] (höchstens 6)",
    wofuer: "Anteile am Ganzen mit Legende und Prozent, z. B. Umsatz nach Sparte.",
  },
  Tabelle: {
    props: "titel?: string, spalten: { titel: string, typ?: \"text\" | \"zahl\" | \"geld\" | \"prozent\" | \"veraenderung\" | \"marke\" | \"datum\" }[], zeilen: (string | number | null | { text: string, companyId?: string, personId?: string })[][]",
    wofuer: "Details mit mehreren Merkmalen je Zeile. veraenderung zeigt Prozent als farbige Pille. Zellen mit companyId/personId werden Links auf Firma/Person.",
  },
  Firmenkarte: {
    props: "companyId: string, grund?: string, score?: number",
    wofuer: "Eine Firma aus AVA; Name, Ort und Status lädt die Karte selbst. Nur mit companyId aus Werkzeug-Ergebnissen.",
  },
  Knopfreihe: {
    props: "(keine)",
    wofuer: "Ordnet mehrere Knöpfe nebeneinander.",
    kinder: true,
  },
  Knopf: {
    props: "label: string, art?: \"primaer\" | \"sekundaer\"",
    wofuer: "Löst über on.press eine der Aktionen aus.",
  },
};

export const AKTIONEN: Record<string, { params: string; wofuer: string }> = {
  oeffnen: { params: "ziel: string", wofuer: "Öffnet eine Seite in AVA: /companies/<companyId>, /personen/<personId>, /radar, /alerts, /workflows, /settings." },
  auftrag: { params: "text: string", wofuer: "Schickt den Text als neue Nachricht des Nutzers an dich, z. B. \"Zeig mir die Kontakte von Müller GmbH\"." },
  link: { params: "url: string", wofuer: "Öffnet eine https-Adresse im Browser (Quelle, Website)." },
};
