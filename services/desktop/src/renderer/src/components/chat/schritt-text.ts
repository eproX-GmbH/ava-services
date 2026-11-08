// L1 (docs/PLAN_LOESUNGSKARTEN.md): Was AVA gerade tut, in Alltagssprache.
// Ersetzt im Chat die Werkzeugnamen ("company_get", "tool_search"), solange
// der Nutzer die Arbeitsschritte nicht ausdruecklich sehen will.

const REGELN: Array<[RegExp, string]> = [
  [/^(tool_search|tool_load|skill_search|skill_get|skill_)/, "Überlegt, wie es am besten geht"],
  [/^bestand_suchen$/, "Durchsucht deine Firmenliste"],
  [/^(company_search|register_live_suche|firma_finden|alle_firmen)/, "Sucht die Firma"],
  [/^(company_contacts|person_|kontakt|contact)/, "Schaut sich die Ansprechpartner an"],
  [/^(company_publications|publication|publikation)/, "Liest Jahresabschlüsse und Veröffentlichungen"],
  [/^(company_|firma_)/, "Schaut sich die Firma an"],
  [/^(import_|retry_stage|firma_neu_verarbeiten)/, "Bereitet Firmen auf"],
  [/^crm_|^connect_crm|^close_/, "Schaut ins CRM"],
  [/^mcp_([a-z0-9]+)_/, "Arbeitet mit $1"],
  [/^a2a_([a-z0-9]+)_/, "Gibt $1 einen Auftrag"],
  [/^notion_/, "Schaut in Notion"],
  [/^obsidian_/, "Schaut in deine Notizen"],
  [/^(mail_|triage_)/, "Schaut in deine Mails"],
  [/^(linkedin_|ln_)/, "Schaut auf LinkedIn"],
  [/^(alerts_|heartbeat)/, "Prüft deine Meldungen"],
  [/^(workflow_)/, "Kümmert sich um den Workflow"],
  [/^(watch_|link_monitor_)/, "Richtet die Beobachtung ein"],
  [/^(radar_|icp_|discovery)/, "Sucht passende Firmen"],
  [/^(datei_|attachment|excel)/, "Liest die Datei"],
  [/^(web_|website|recherche|research)/, "Recherchiert im Netz"],
  [/^(buying_center)/, "Arbeitet an der Power Map"],
  [/^(app_oeffnen|navigate)$/, "Legt einen Knopf zur Seite an"],
  [/^(remember|recall_memory|memory)/, "Erinnert sich"],
  [/^(settings_|vorschlaege_|ollama_|voice_|updater_)/, "Passt die Einstellungen an"],
  [/^(ask_user_)/, "Wartet auf deine Antwort"],
];

function dienstName(slug: string): string {
  if (slug === "compleadly") return "CompLeadly";
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

export function schrittText(toolName: string | undefined): string | null {
  if (!toolName) return null;
  for (const [re, text] of REGELN) {
    const m = re.exec(toolName);
    if (m) return m[1] && text.includes("$1") ? text.replace("$1", dienstName(m[1])) : text;
  }
  return null;
}
