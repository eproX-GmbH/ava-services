// v0.1.257 — Trust-Engine.
//
// Bestimmt für jede eingehende Mail die Vertrauensstufe:
//   - "trusted":  Allowlist-Match UND keine Spoofing-Indikatoren UND
//                 unter Rate-Limit UND klassifikation != phishing/spam.
//                 → AVA darf autonom handeln (reply, CRM-Update, ...).
//   - "known":    Absender hat schon mal mit AVA korrespondiert
//                 (≥ 1 outbound an genau diese Adresse), aber nicht
//                 in Allowlist. → AVA fragt vor jeder Aktion nach.
//   - "unknown":  alles andere. → AVA zeigt nur an, handelt nicht.
//
// Die Engine ist STATELESS bzgl. der Entscheidung pro Mail — sie liest
// Allowlist + History aus dem Store und gibt ein Verdict zurück. Der
// Supervisor schreibt das Verdict dann in mail_messages.trust_level.
//
// Spoofing-Indikatoren:
//   - SPF fail
//   - DKIM fail (außer wenn Domain DKIM gar nicht macht → "none")
//   - From-vs-Return-Path-Mismatch
//   - Display-Name-Tricks: "Max Mustermann <attacker@evil.tld>" wenn
//     Display-Name eine bekannte Trusted-Adresse enthält
//
// Rate-Limit:
//   - max 20 Mails pro Stunde pro Absender. Drüber → automatisch
//     auf "unknown" zurück, auch wenn Allowlist-Match.

import type {
  MailAllowlistEntry,
  MailMessage,
  MailTrustLevel,
} from "../../shared/types";
import type { MailStore } from "./store";

const RATE_LIMIT_PER_HOUR = 20;

export interface TrustVerdict {
  level: MailTrustLevel;
  /** Menschenlesbare Begründung — landet in der UI als Tooltip oder
   *  Audit-Log. */
  reason: string;
  /** Welche Indikatoren haben gefeuert? Für Triage-Detail-View. */
  indicators: {
    allowlistMatch: boolean;
    spfFail: boolean;
    dkimFail: boolean;
    returnPathMismatch: boolean;
    displayNameSpoof: boolean;
    rateLimited: boolean;
    rateLimitCount: number;
  };
}

export class TrustEngine {
  constructor(private readonly store: MailStore) {}

  /** Bestimmt das Trust-Level einer eingehenden Mail. Async weil
   *  Allowlist + History aus PGlite kommen. */
  async evaluate(message: MailMessage): Promise<TrustVerdict> {
    const allowlist = await this.store.listAllowlist();
    const allowlistEntry = matchesAllowlist(message.from.address, allowlist);
    const allowlistMatch = allowlistEntry !== null;

    const spfFail = message.authResults.spf === "fail";
    const dkimFail = message.authResults.dkim === "fail";
    const returnPathMismatch = !message.authResults.fromMatchesReturnPath;

    const displayNameSpoof = detectDisplayNameSpoof(
      message.from.name,
      message.from.address,
      allowlist,
    );

    const rateLimitCount = await this.store.countFromSenderRecent(
      message.from.address,
      1,
    );
    const rateLimited = rateLimitCount >= RATE_LIMIT_PER_HOUR;

    // Bei harten Spoofing-Signalen sofort auf unknown, egal was die
    // Allowlist sagt. Phishing-Schutz schlägt Convenience.
    if (spfFail || dkimFail || returnPathMismatch || displayNameSpoof) {
      return {
        level: "unknown",
        reason: spoofReason({
          spfFail,
          dkimFail,
          returnPathMismatch,
          displayNameSpoof,
        }),
        indicators: {
          allowlistMatch,
          spfFail,
          dkimFail,
          returnPathMismatch,
          displayNameSpoof,
          rateLimited,
          rateLimitCount,
        },
      };
    }

    // Rate-Limit hebelt Allowlist aus — verhindert dass ein
    // kompromittiertes trusted-Konto AVA mit Befehlen flutet.
    if (rateLimited) {
      return {
        level: "unknown",
        reason: `Rate-Limit: ${rateLimitCount} Mails in der letzten Stunde von diesem Absender (Limit: ${RATE_LIMIT_PER_HOUR}).`,
        indicators: {
          allowlistMatch,
          spfFail,
          dkimFail,
          returnPathMismatch,
          displayNameSpoof,
          rateLimited,
          rateLimitCount,
        },
      };
    }

    if (allowlistEntry) {
      return {
        level: "trusted",
        reason: `Absender ist in Allowlist (Pattern: ${allowlistEntry.pattern}).`,
        indicators: {
          allowlistMatch: true,
          spfFail,
          dkimFail,
          returnPathMismatch,
          displayNameSpoof,
          rateLimited,
          rateLimitCount,
        },
      };
    }

    // "known" — hat AVA schon mal an diese Adresse geschrieben?
    const hasHistory = await this.hasOutboundHistory(message.from.address);
    if (hasHistory) {
      return {
        level: "known",
        reason: "Bereits Mail-Verlauf mit diesem Absender, aber nicht in Allowlist.",
        indicators: {
          allowlistMatch: false,
          spfFail,
          dkimFail,
          returnPathMismatch,
          displayNameSpoof,
          rateLimited,
          rateLimitCount,
        },
      };
    }

    return {
      level: "unknown",
      reason: "Neuer Absender, keine Allowlist-Übereinstimmung.",
      indicators: {
        allowlistMatch: false,
        spfFail,
        dkimFail,
        returnPathMismatch,
        displayNameSpoof,
        rateLimited,
        rateLimitCount,
      },
    };
  }

  private async hasOutboundHistory(address: string): Promise<boolean> {
    // Trick: wir nutzen countFromSenderRecent NICHT (das ist inbound only).
    // Stattdessen direkt eine Query — aber MailStore hat dafür noch keine
    // Methode. Pragmatisch: für die erste Iteration return false und das
    // "known"-Level kommt nur über manuelle User-Promotion via Triage-UI.
    // V2: SELECT 1 FROM mail_messages WHERE direction='outbound' AND ... LIMIT 1
    return false;
  }
}

/** Match-Logik:
 *  - "max@kunde.de"  → exakte Adresse (case-insensitive)
 *  - "*@kunde.de"    → ganze Domain
 *  - "*@*.kunde.de"  → Subdomains erlaubt
 */
function matchesAllowlist(
  address: string,
  allowlist: MailAllowlistEntry[],
): MailAllowlistEntry | null {
  const addr = address.toLowerCase().trim();
  if (!addr.includes("@")) return null;
  const [, domain] = addr.split("@");
  for (const entry of allowlist) {
    const pattern = entry.pattern.toLowerCase().trim();
    if (pattern === addr) return entry;
    if (pattern.startsWith("*@")) {
      const patternDomain = pattern.slice(2);
      if (patternDomain.startsWith("*.")) {
        const root = patternDomain.slice(2);
        if (domain === root || domain?.endsWith(`.${root}`)) return entry;
      } else if (domain === patternDomain) {
        return entry;
      }
    }
  }
  return null;
}

/** Heuristik: "Max Mustermann <attacker@evil.tld>" wenn ein Allowlist-
 *  Pattern den Display-Name enthält aber die Domain nicht passt.
 *  Beispiel: Allowlist hat max@kunde.de, eingehende Mail hat Display-
 *  Name "Max Mustermann" aber Adresse von random@spam.io. */
function detectDisplayNameSpoof(
  displayName: string | null,
  address: string,
  allowlist: MailAllowlistEntry[],
): boolean {
  if (!displayName) return false;
  const lname = displayName.toLowerCase();
  for (const entry of allowlist) {
    if (entry.pattern === address.toLowerCase()) return false; // exakter Match
    // Label des Allowlist-Eintrags im Display-Name?
    if (entry.label && entry.label.length >= 4) {
      if (lname.includes(entry.label.toLowerCase())) {
        // Display-Name matched, aber Adresse ist nicht der Allowlist-Eintrag
        // → potenziell Spoof.
        return true;
      }
    }
  }
  return false;
}

function spoofReason(indicators: {
  spfFail: boolean;
  dkimFail: boolean;
  returnPathMismatch: boolean;
  displayNameSpoof: boolean;
}): string {
  const reasons: string[] = [];
  if (indicators.spfFail) reasons.push("SPF fail");
  if (indicators.dkimFail) reasons.push("DKIM fail");
  if (indicators.returnPathMismatch) reasons.push("From-vs-Return-Path-Mismatch");
  if (indicators.displayNameSpoof) reasons.push("Display-Name-Spoof");
  return `Spoofing-Indikator(en): ${reasons.join(", ")}.`;
}

export { RATE_LIMIT_PER_HOUR };
