import type { AlertTickInfo } from "./types";

// Eine Zeile je Lauf der Meldungs-Prüfung (Heartbeat) — für den Verlauf in
// den Einstellungen und das Protokoll. Vorher stand dort „0 Kandidat(en)
// geprüft“, was wie „nichts getan“ gelesen wurde (Befund Patrick
// 2026-11-02); tatsächlich zählte die Zahl nur die neuen Fundstellen seit
// dem letzten Lauf, meist null. Jetzt steht da, was wirklich passiert ist.

function zahl(n: number, einzahl: string, mehrzahl: string): string {
  return `${n} ${n === 1 ? einzahl : mehrzahl}`;
}

export function laufZusammenfassung(t: AlertTickInfo): string {
  if (t.skipped) {
    return `übersprungen${t.reason ? ` (${t.reason})` : ""}`;
  }
  const teile: string[] = [];
  teile.push(
    t.candidatesSeen > 0
      ? zahl(t.candidatesSeen, "neue Fundstelle", "neue Fundstellen")
      : "keine neuen Fundstellen",
  );
  if (t.beurteilt > 0) teile.push(`${t.beurteilt} bewertet`);
  if (t.alertsCreated > 0) teile.push(zahl(t.alertsCreated, "neue Meldung", "neue Meldungen"));
  if (t.duplicates > 0) teile.push(`${t.duplicates} bereits gemeldet`);
  if (t.bereitsBeurteilt > 0) teile.push(`${t.bereitsBeurteilt} schon früher bewertet`);
  if (t.rueckstand > 0) {
    teile.push(t.rueckstand === 1 ? "1 wartet auf den nächsten Lauf" : `${t.rueckstand} warten auf den nächsten Lauf`);
  } else if (t.beurteilt === 0 && t.candidatesSeen === 0) {
    teile.push("nichts zu bewerten");
  }
  return teile.join(" · ");
}
