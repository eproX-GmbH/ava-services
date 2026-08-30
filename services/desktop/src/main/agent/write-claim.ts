// v0.1.465 — Write-Claim-Erkennung (M3 der Zuverlässigkeits-Evaluation).
//
// "Nichts ist schlimmer, als wenn AVA sagt 'hat geklappt', wenn es
// nicht geklappt hat." Dieses Modul beantwortet deterministisch zwei
// Fragen über einen Agenten-Turn:
//
//   1. Lief ein Schreib-Tool ERFOLGREICH? (isWriteTool + ok-Flag,
//      gezählt vom Aufrufer über den Tool-Trace)
//   2. BEHAUPTET der Antworttext den Vollzug einer AVA-Aktion?
//      (claimsWriteAction — Vollzugs-Verb in Vergangenheitsform UND
//      Aktions-Objekt im selben Satz)
//
// Konsumenten: telegram/inbound.ts (hängt bei Diskrepanz einen
// Korrektur-Hinweis an die Antwort) und agent/orchestrator.ts
// (Post-Turn-Audit für ALLE autonomen Turns — auch Mail, wo die
// Antwort schon mitten im Turn rausging und nicht mehr korrigierbar
// ist, aber sichtbar werden muss).
//
// Bewusst reine Regex/String-Logik, kein LLM: der Wächter darf selbst
// nicht halluzinieren können. Und bewusst konservativ: lieber eine
// Behauptung durchlassen als eine echte Aktion als Halluzination
// markieren.

/** Tools, die nach außen SCHREIBEN. Großzügig gefasst — ein Treffer
 *  unterdrückt nur die Warnung, erzeugt nie eine. */
const WRITE_TOOL_RE =
  /^(crm_(create|update|log|sync|enrich|associate|disassociate|delete|complete|link)|mail_(reply|send|forward|archive|allowlist)|notion_(create|update|delete|append)|obsidian_(create|append|write|delete)|import_|profile_(set|propose)|watch_(register|remove|pause|resume)|freshness_(set|pin|unpin|run)|scheduler_|discovery_|icp_)/;

export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_RE.test(name);
}

/** Vollzugs-Behauptung (Vergangenheitsform mit Hilfsverb —
 *  Konjunktiv/Futur wie „würde anlegen"/„wird angelegt" matcht nicht). */
const CLAIM_RE =
  /\b(habe?|wurden?|ist|sind)\b[^.!?\n]{0,80}\b(angelegt|erfasst|eingetragen|aktualisiert|protokolliert|erstellt|hinterlegt|gespeichert|dokumentiert|verkn(ü|ue)pft|(ü|ue)bernommen|archiviert|verschickt|gesendet)\b/i;

/** Aktions-Objekte, auf die sich die Behauptung beziehen muss (im
 *  SELBEN Satz). Ohne diese Kopplung schlüge der Wächter auch bei
 *  Faktenaussagen an („Der Jahresabschluss wurde im Bundesanzeiger
 *  hinterlegt"). */
const CLAIM_OBJECT_RE =
  /\b(hubspot|crm|notiz|aktivit(ä|ae)t|aufgabe|task|deal|company|kontakt(e|daten)?|verkn(ü|ue)pfung|mail|e-mail|erinnerung|termin|notion|obsidian|profil|import)\b/i;

/** Behauptet der Text in irgendeinem Satz den Vollzug einer
 *  AVA-Aktion? Satzweise geprüft, damit Verb und Objekt zusammengehören. */
export function claimsWriteAction(text: string): boolean {
  return text
    .split(/[.!?\n]+/)
    .some((s) => CLAIM_RE.test(s) && CLAIM_OBJECT_RE.test(s));
}
