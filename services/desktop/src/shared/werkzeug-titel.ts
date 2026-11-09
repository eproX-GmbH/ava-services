// Dauer-Erlaubnisse (docs/PLAN_ERLAUBNISSE.md §2.4): Werkzeugname in Alltagssprache,
// z. B. "mail_entwuerfe_ablegen" → "Mail-Entwürfe ablegen". Bereich aus dem Praefix,
// Taetigkeit aus der Endung; unbekannte Namen fallen auf den lesbar gemachten Namen zurueck.

const BEREICHE: Array<[RegExp, string]> = [
  [/^mail_entw/, "Mail-Entwürfe"],
  [/^mail_allowlist/, "Vertraute Mail-Empfänger"],
  [/^(mail_|triage_)/, "Mails"],
  [/^crm_/, "CRM-Einträge"],
  [/^close_/, "Close-Einträge"],
  [/^hubspot_/, "HubSpot-Einträge"],
  [/^notion_/, "Notion-Seiten"],
  [/^obsidian_/, "Notizen"],
  [/^telegram_/, "Telegram-Nachrichten"],
  [/^(person|personen|kontakt|contact)/, "Kontakte"],
  [/^(import_|retry_stage)/, "Firmen"],
  [/^transaction_/, "Vorgänge"],
  [/^(company|firma|firmen)/, "Firmen"],
  [/^linkedin_/, "LinkedIn"],
  [/^alerts?_/, "Meldungen"],
  [/^workflow_/, "Workflows"],
  [/^(watch|watchlist|link_monitor)/, "Beobachtungen"],
  [/^(radar_|discovery_|icp_)/, "Radar-Treffer"],
  [/^buying_center/, "Power Map"],
  [/^(thema|themen|fokus)/, "Fokus-Themen"],
  [/^schedule/, "Wiederkehrende Aufgaben"],
  [/^(remember|memory|forget)/, "Gedächtnis"],
];

const TAETIGKEITEN: Array<[RegExp, string]> = [
  [/(_delete|_remove|_clear|_reset|_purge|loeschen)/, "löschen"],
  [/_send/, "senden"],
  [/_reply/, "beantworten"],
  [/_forward/, "weiterleiten"],
  [/_ablegen/, "ablegen"],
  [/(^import_|_import)/, "importieren"],
  [/_save/, "speichern"],
  [/(_decide|_approve|_freigeben)/, "übernehmen"],
  [/(_sync|_associate|_link)/, "verknüpfen"],
  [/(_create|_add|_register|_append|_log|_write|_anlegen)/, "anlegen"],
  [/(_update|_set|_rename|_move|_mark|_pin|_unpin|_archive|_complete|_pause|_resume|_config)/, "ändern"],
  [/(_start|_run|_scan)/, "starten"],
  [/_share/, "teilen"],
];

const gross = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function werkzeugTitel(name: string): string {
  // Verbundene Dienste: "mcp_close_create_lead" → "Close: Create lead".
  const dienst = /^(?:mcp|a2a)_([a-z0-9]+)_(.+)$/.exec(name);
  if (dienst) return `${gross(dienst[1]!)}: ${gross(dienst[2]!.replace(/_/g, " "))}`;
  let bereich: string | null = null;
  for (const [re, text] of BEREICHE) {
    if (re.test(name)) {
      bereich = text;
      break;
    }
  }
  const taetigkeit = TAETIGKEITEN.find(([re]) => re.test(name))?.[1] ?? null;
  if (bereich && taetigkeit) return `${bereich} ${taetigkeit}`;
  const lesbar = gross(name.replace(/_/g, " "));
  return bereich ? `${bereich}: ${lesbar}` : lesbar;
}
