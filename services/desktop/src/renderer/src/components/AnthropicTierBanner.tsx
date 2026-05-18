import type { MouseEvent } from "react";
import type { AnthropicTierInfo } from "../../../shared/types";

// v0.1.209 — Hinweisbanner für Anthropic-Tier-1-Accounts.
//
// Anthropics Default-Limit für frisch aufgeladene API-Keys liegt bei
// ~30 000 Input-Token pro Minute. AVAs Toolregistry + Systemprompt +
// Profilkontext schöpfen das im Erst-Request fast vollständig aus,
// was bei längeren Recherchen sofort in eine 429 läuft. Nicht-Tech-
// Nutzer, die sich mühsam einen Key beschafft haben, verstehen die
// englische Original-Fehlermeldung nicht und sehen AVA als kaputt.
//
// Dieser Banner erscheint unter der Key-Karte (Settings + Wizard),
// sobald wir den Tier ermittelt haben — er erklärt das Limit auf
// Deutsch und führt mit einem Klick zur richtigen Anthropic-Console-
// Seite, wo Tier 2 freigeschaltet wird. Wir zeigen ihn NUR für
// `tier-1`; tier-2 und tier-3+ gelten als ausreichend.
//
// Vermieden wurde bewusst:
//   - Aktive Sperre/Warning-Dialog → der Key funktioniert technisch,
//     also lassen wir Nutzer arbeiten.
//   - Inline-Tutorial mit Screenshots → wäre nice, aber wartungs-
//     intensiv (Anthropic ändert ihre UI). Stattdessen direkter
//     Deeplink zur Limits-Seite.

const CONSOLE_LIMITS_URL = "https://console.anthropic.com/settings/limits";

export function AnthropicTierBanner({
  tier,
}: {
  tier: AnthropicTierInfo | null | undefined;
}) {
  // Banner nur bei Tier 1 zeigen. Tier 2 / Tier 3+ → still bleiben.
  if (!tier || tier.tierLabel !== "tier-1") return null;

  const openConsole = (e: MouseEvent): void => {
    e.preventDefault();
    void window.api.shell.openExternal(CONSOLE_LIMITS_URL);
  };

  return (
    <div className="tier-banner tier-banner--warn" role="status">
      <p className="tier-banner__title">
        ⚠️ Anthropic-Account auf Tier 1 ({tier.inputTokensPerMinute.toLocaleString("de-DE")} Token/Min)
      </p>
      <p className="tier-banner__body">
        Tier 1 ist Anthropics Standard für neue API-Konten und wird bei
        längeren Recherchen schnell knapp. AVA versucht trotzdem, dein
        Token-Budget durch Prompt-Caching zu schonen — bei mehreren
        Hintergrund-Aufgaben gleichzeitig kann es aber weiterhin zu
        Wartemeldungen kommen.
      </p>
      <p className="tier-banner__body">
        <strong>Tier 2 verdoppelt das Limit</strong> und schaltet sich
        automatisch frei, sobald 5 USD über die API verbraucht oder
        vorab aufgeladen wurden — kein Antrag, kein Warten.
      </p>
      <p className="tier-banner__actions">
        <a
          href={CONSOLE_LIMITS_URL}
          onClick={openConsole}
          className="tier-banner__link"
        >
          Anthropic-Console öffnen → Limits prüfen
        </a>
      </p>
    </div>
  );
}
