// v0.1.224 — Pre-Persist-Redaktion sensitiver Tokens im Chat-Transcript.
//
// Hintergrund: Nutzer werden in Knowledge-Integrationen (Notion,
// Obsidian, später weitere) ihre API-Tokens via Chat eingeben — AVA
// erklärt z. B. „kopier mir den Notion-Token aus der Integrations-
// Seite". Wenn dieser Token unredacted in der Transcript-Datei
// landet, hat jeder mit Lesezugriff auf `<userData>/agent/memory/`
// dauerhaft Zugriff auf die Notion-Workspaces des Nutzers.
//
// Lösung: Bevor `memory.append()` eine User-Message auf Disk
// schreibt, läuft der Text durch `redactSensitiveTokens()`. Bekannte
// Token-Patterns werden durch `[redacted: <label>]` ersetzt. Der
// ursprüngliche Token-Wert wird NICHT mit zurückgegeben — Token-
// Aufnahme passiert über einen separaten, expliziten Code-Pfad in
// den Knowledge-Connect-Tools (P2).
//
// Designprinzipien:
//   - Patterns liberal: lieber einen Falschen-positive-Token
//     redacten als einen echten Token im Klartext stehen lassen.
//   - Suffix-Mindestlänge im Regex schützt davor, harmlose
//     Strings wie "secret_test" zu zerschießen.
//   - Token-Kataloge fluktuieren — bei neuen Providern hier
//     ergänzen, NICHT ad-hoc inline irgendwo.

export interface TokenPattern {
  /** Regex, der den gesamten Token-String matched. Muss `g`-Flag
   *  haben für globale Ersetzung. */
  re: RegExp;
  /** Bezeichner im redacted-Marker. Erscheint im Transcript als
   *  `[redacted: Notion-Integration-Token]`. */
  label: string;
}

/**
 * Liste bekannter Sensitive-Token-Patterns. Reihenfolge: spezifischer
 * vorher als generischer (damit ein präzises Pattern den generischen
 * Catch-all nicht zuerst auslöst).
 */
export const TOKEN_PATTERNS: TokenPattern[] = [
  // Notion — zwei aktuelle Formate. Beide vom User in Notion ->
  // Integrations -> Secrets generiert.
  {
    re: /\bsecret_[A-Za-z0-9]{40,}\b/g,
    label: "Notion-Integration-Token (Legacy-Format)",
  },
  {
    re: /\bntn_[A-Za-z0-9_]{40,}\b/g,
    label: "Notion-Integration-Token",
  },

  // Anthropic — Subscription-OAuth + klassische API-Keys.
  {
    re: /\bsk-ant-oat01-[A-Za-z0-9_-]{50,}\b/g,
    label: "Anthropic-Subscription-Token",
  },
  {
    re: /\bsk-ant-api03-[A-Za-z0-9_-]{50,}\b/g,
    label: "Anthropic-API-Key",
  },

  // OpenAI — klassisch + Projects/Service-Accounts.
  {
    re: /\bsk-proj-[A-Za-z0-9_-]{40,}\b/g,
    label: "OpenAI-Projekt-Schlüssel",
  },
  {
    re: /\bsk-svcacct-[A-Za-z0-9_-]{40,}\b/g,
    label: "OpenAI-Service-Account-Schlüssel",
  },
  {
    re: /\bsk-[A-Za-z0-9]{40,}\b/g,
    label: "OpenAI-API-Key",
  },

  // Google Gemini / Cloud-API-Keys (AIza-Präfix ist sehr eindeutig).
  {
    re: /\bAIza[A-Za-z0-9_-]{30,}\b/g,
    label: "Google-API-Key",
  },

  // Mistral — alphanumerische 32+-Zeichen-IDs, kein Markant-Präfix.
  // Wir matchen NUR mit explizitem Mistral-Kontext-Wort davor, um
  // false positives zu vermeiden.
  {
    re: /\b(?:mistral[- ]?(?:api[- ]?)?key|mistral[- ]?token)\s*[:=]\s*([A-Za-z0-9]{32,})\b/gi,
    label: "Mistral-API-Key",
  },

  // GitHub — PATs (klassisch + fine-grained) + App-Installation-Tokens.
  {
    re: /\bghp_[A-Za-z0-9]{36,}\b/g,
    label: "GitHub-Personal-Access-Token",
  },
  {
    re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
    label: "GitHub-Fine-Grained-PAT",
  },

  // Slack-Bots/User-Tokens.
  {
    re: /\bxox[abprs]-[A-Za-z0-9-]{40,}\b/g,
    label: "Slack-Token",
  },

  // HubSpot — Private-App-Tokens (pat- oder eu1-Präfix je nach Region).
  {
    re: /\bpat-(?:na1|eu1|na2|eu2)-[A-Za-z0-9-]{36,}\b/g,
    label: "HubSpot-Private-App-Token",
  },
];

/**
 * Läuft den Input-Text durch alle bekannten Token-Patterns und
 * ersetzt Matches durch `[redacted: <label>]`. Returns:
 *   - `redacted`: der bereinigte Text (das was auf Disk landet)
 *   - `matches`: Array gefundener Labels (für Audit-Logging /
 *     UI-Anzeige „1 Token wurde aus deiner Nachricht entfernt")
 *   - `original` ist NICHT enthalten — Caller, die den Token-Wert
 *     brauchen (Knowledge-Connect-Flow), nutzen einen separaten
 *     Extract-Pfad (siehe P2).
 */
export function redactSensitiveTokens(text: string): {
  redacted: string;
  matches: string[];
} {
  if (!text || text.length === 0) {
    return { redacted: text, matches: [] };
  }
  let working = text;
  const matches: string[] = [];
  for (const pattern of TOKEN_PATTERNS) {
    // Wir nutzen einen Replacer, der für jeden Treffer das Label
    // einmal in `matches` einträgt + den Marker einsetzt.
    working = working.replace(pattern.re, () => {
      matches.push(pattern.label);
      return `[redacted: ${pattern.label}]`;
    });
  }
  return { redacted: working, matches };
}

/**
 * Helper für die Knowledge-Connect-Tools (P2): extrahiert den ERSTEN
 * passenden Token eines bestimmten Patterns aus dem Text, OHNE ihn
 * im Text zu hinterlassen. Caller bekommt den rohen Token-Wert; der
 * Text-Rest ist redacted. Verwendet, wenn der User per Chat
 * tatsächlich einen Token paste'd und wir den entgegennehmen wollen.
 *
 * Wenn kein Token des erwarteten Patterns gefunden wird, gibt
 * `extractedToken: null` zurück.
 */
export function extractAndRedactToken(
  text: string,
  expectedPatternLabel: string,
): {
  redacted: string;
  extractedToken: string | null;
  matches: string[];
} {
  if (!text || text.length === 0) {
    return { redacted: text, extractedToken: null, matches: [] };
  }
  const pattern = TOKEN_PATTERNS.find((p) => p.label === expectedPatternLabel);
  if (!pattern) {
    // Unbekanntes Pattern-Label — wir fallen auf die normale
    // Redaktion zurück.
    const r = redactSensitiveTokens(text);
    return { redacted: r.redacted, extractedToken: null, matches: r.matches };
  }
  // Erst den erwarteten Token finden + extrahieren.
  let extractedToken: string | null = null;
  let working = text.replace(pattern.re, (full) => {
    if (extractedToken === null) extractedToken = full;
    return `[redacted: ${pattern.label}]`;
  });
  // Dann die übrigen Patterns redacten (für den Fall, dass im Text
  // noch andere Tokens stehen).
  const matches: string[] = extractedToken ? [pattern.label] : [];
  for (const p of TOKEN_PATTERNS) {
    if (p === pattern) continue;
    working = working.replace(p.re, () => {
      matches.push(p.label);
      return `[redacted: ${p.label}]`;
    });
  }
  return { redacted: working, extractedToken, matches };
}
