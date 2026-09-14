// v0.1.646 (docs/PLAN_CHAT_VORSCHLAEGE.md, V1) — Verdichtete Faehigkeitsliste
// (Variante B): rund 35 Gruppen mit je einem Satz statt 240 Tool-Zeilen.
// Das erzeugende Modell sieht NUR diese Liste, damit es keine Funktionen
// erfindet ("Mit Facebook verbinden"). Der Code prueft Chips spaeter gegen
// die Gruppen-IDs (harte Schranke).
//
// Pflege: neue Tool-Datei → neue Gruppe oder bestehende ergaenzen. Der Test
// scripts/test-suggestions.mjs meldet Tools, die keiner Gruppe zugeordnet
// sind.

import type { Faehigkeit } from "../../shared/nutzerstand-types";

export const FAEHIGKEITEN: Faehigkeit[] = [
  { id: "firmen", text: "Firmen suchen und Profil, Website, Handelsregister-Daten, Publikationen, Kennzahlen, Tech-Stack und Datenqualitaet einer Firma abrufen", tools: ["company_*"] },
  { id: "kontakte", text: "Kontaktpersonen einer Firma mit Beleg anzeigen, Herkunftsnachweis, Art.-14-Hinweis, Person loeschen", tools: ["contact_linkedin_lookup", "person_*"], feature: "kontakte" },
  { id: "email_ableitung", text: "E-Mail-Adressen nach dem Adressmuster der Firma ableiten und per Mail-Server-Anfrage pruefen (Hintergrund, Verlauf, Vorschau)", tools: ["email_muster_*"], feature: "kontakte" },
  { id: "import", text: "Excel-Listen oder Firmen aus dem CRM importieren und komplett anreichern; Importstand, Fehler und Wiederholung je Schritt", tools: ["import_*", "resolve_import_matches", "retry_stage", "transactions_list", "transaction_get", "transaction_entities", "transaction_errors", "transaction_pipeline"] },
  { id: "teilen", text: "Recherchen und Radar-Firmen mit der Organisation teilen oder von Kollegen uebernehmen", tools: ["transaction_share", "transaction_adopt", "radar_share", "workflow_share", "workflow_org_list", "workflow_adopt"] },
  { id: "best_match", text: "Zu einer Anfrage oder einem Angebot die passendsten Firmen aus dem Bestand ranken (Best-Match, Vergleich, Angebotsanalyse)", tools: ["evaluation_*"] },
  { id: "icp", text: "Idealkundenprofil (ICP) festlegen, aus Website-URLs ableiten oder anpassen", tools: ["icp_*"] },
  { id: "radar", text: "Firmen-Radar: Scan in einer Region starten, Kandidaten mit Mini-Profil und ICP-Score ansehen, importieren oder verwerfen, Automatik und Deckel einstellen, Live-Stand", tools: ["discovery_*", "radar_config", "radar_activity", "geo_places_nearby"] },
  { id: "publikationen", text: "Jahresabschluesse und Publikationen einer Firma durchsuchen", tools: ["publication_search", "publication_analysis_config"] },
  { id: "hubspot", text: "HubSpot verbinden und nutzen: Firmen, Kontakte, Deals, Aufgaben, Notizen lesen, anlegen, aktualisieren, verknuepfen; Firmen aus AVA mit HubSpot verknuepfen", tools: ["crm_*", "connect_crm", "disconnect_crm"] },
  { id: "notion", text: "Notion verbinden, Datenbanken und Seiten lesen, anlegen, aktualisieren", tools: ["notion_*"] },
  { id: "obsidian", text: "Obsidian verbinden, Notizen lesen, anlegen, aendern, Tags und Ordner", tools: ["obsidian_*"] },
  { id: "linkedin_beobachter", text: "LinkedIn-Beobachter: eigenes Konto verbinden, Feed-Signale zu Firmen (Personalwechsel, Produkte, Messen) erkennen und bewerten", tools: ["linkedin_status", "linkedin_connect", "linkedin_disconnect", "linkedin_scan_cancel", "linkedin_signals_cancel", "linkedin_killswitch", "linkedin_beobachter"], feature: "linkedin.beobachter" },
  { id: "watchlist", text: "Personen-Watchlist: oeffentliche LinkedIn-Aktivitaet einzelner Ansprechpartner beobachten", tools: ["linkedin_watchlist_*"], feature: "linkedin.watchlist" },
  { id: "personen_radar", text: "Personen-Radar: Engagement auf LinkedIn-Beitraegen als neue Firmenkandidaten", tools: ["personen_radar_*"], feature: "linkedin.radar" },
  { id: "link_monitor", text: "Website-Ueberwachung: beliebige URL beobachten und bei Aenderung melden", tools: ["link_monitor_*"] },
  { id: "meldungen", text: "Meldungen (Alerts) ansehen, verwerfen, Einstellungen fuer Benachrichtigungen", tools: ["alerts_*"] },
  { id: "watches", text: "Beobachtungsregeln (Watches) mit eigener Bewertungsvorschrift anlegen und verwalten", tools: ["watch_*"] },
  { id: "mail", text: "Mail-Postfach verbinden, Posteingang lesen, antworten, weiterleiten, archivieren, Mail-Triage einstellen", tools: ["mail_*"], feature: "mail" },
  { id: "telegram", text: "Telegram verbinden: Meldungen, Kurzprofile und Freigaben aufs Handy, Nachrichten senden", tools: ["telegram_*"], feature: "telegram" },
  { id: "workflows", text: "Workflows: Ablaeufe aus dem Gespraech speichern, mit Zeitplan oder Ereignis ausfuehren, Freigaben, Vorlagen, Laufhistorie", tools: ["workflow_*"], feature: "workflows" },
  { id: "skills", text: "Skills: wiederverwendbare Routinen per Slash-Befehl anlegen und nutzen", tools: ["skill_*"] },
  { id: "zeitplan", text: "Erinnerungen und wiederkehrende Mail-Schleifen planen", tools: ["schedule_*"] },
  { id: "gedaechtnis", text: "Sich Dinge merken und spaeter abrufen (Gedaechtnis ueber Gespraeche hinweg)", tools: ["recall_memory", "remember", "forget_memory"] },
  { id: "profil", text: "Eigenes Nutzerprofil (Rolle, Branchen, Regionen) pflegen", tools: ["profile_*"] },
  { id: "aktualitaet", text: "Aktualitaet der Firmendaten: Auffrischen, Frequenzen je Datenquelle, Firmen anpinnen", tools: ["freshness_*"] },
  { id: "chatverlauf", text: "Fruehere Gespraeche auflisten, laden, loeschen", tools: ["chat_history_*"] },
  { id: "navigation", text: "Seiten der App oeffnen, Rueckfragen stellen, Hinweise anzeigen", tools: ["navigate", "notify", "ask_user_choice", "ask_user_text"] },
  { id: "lokales_modell", text: "Lokales KI-Modell (Ollama) laden, Status, neu starten", tools: ["ollama_*"] },
  { id: "sprache", text: "Spracheingabe: Whisper-Modell installieren", tools: ["voice_*"] },
  // ---- Verwaltung: nie auf der Startseite ----
  { id: "einstellungen", text: "KI-Anbieter, Schluessel, Modell, Token-Limit einstellen", tools: ["settings_*"], verwaltung: true },
  { id: "organisation", text: "Organisation verwalten: Mitglieder, Vorgaben, Anbieter-Sperre, Limits, Verbrauch, Abrechnung", tools: ["org_*"], verwaltung: true },
  { id: "konto", text: "Kontoinformationen", tools: ["account_info"], verwaltung: true },
  { id: "system", text: "Producer-Status und -Logs, Erreichbarkeit, Updates, Selbstkorrektur, Tool-Suche", tools: ["producers_*", "reachability_*", "updater_*", "report_self_correction", "tool_search", "tool_load", "vorschlaege_status"], verwaltung: true },
];

function passt(muster: string, name: string): boolean {
  return muster.endsWith("*") ? name.startsWith(muster.slice(0, -1)) : name === muster;
}

/** Gruppen, die mit den geladenen Tools und der Policy tatsaechlich verfuegbar sind. */
export function verfuegbareFaehigkeiten(toolNamen: string[], gesperrteModule: string[], opts: { mitVerwaltung?: boolean } = {}): Faehigkeit[] {
  return FAEHIGKEITEN.filter((f) => {
    if (f.verwaltung && !opts.mitVerwaltung) return false;
    if (f.feature && gesperrteModule.includes(f.feature)) return false;
    return f.tools.some((m) => toolNamen.some((n) => passt(m, n)));
  });
}

/** Prompt-Zeilen: "- id: text". */
export function faehigkeitenText(faehigkeiten: Faehigkeit[]): string {
  return faehigkeiten.map((f) => `- ${f.id}: ${f.text}`).join("\n");
}

/** Tool-Namen, die keiner Gruppe zugeordnet sind (Pflege-Hinweis, Test). */
export function nichtZugeordnet(toolNamen: string[]): string[] {
  return toolNamen.filter((n) => !FAEHIGKEITEN.some((f) => f.tools.some((m) => passt(m, n))));
}
