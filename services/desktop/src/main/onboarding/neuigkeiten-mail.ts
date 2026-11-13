// O5 (docs/PLAN_ONBOARDING.md): Neuigkeiten per Mail. Ungelesene neue Meldungen zu Firmen
// gehen gesammelt an das Gateway; das versendet nur mit bestaetigter Zustimmung
// (Double-Opt-in aus der Willkommensmail) und hoechstens eine Mail je 20 Stunden.
// Die Marke neuigkeitenBis haelt fest, bis wohin Meldungen erledigt sind.
// Burggraben 4: einmal im Monat traegt die Mail eine Zeile, was der Rechner beim
// Mithelfen im Vormonat beigetragen hat (Marke beitragGemeldet).

import type { GatewayClient } from "../agent/gateway-client";
import type { Alert, AlertKind } from "../../shared/types";
import type { MithelfenBeitrag } from "../../shared/register-delta-types";
import { markeLesen, markeSetzen, onboardingDatei } from "./marke";

/** Meldungsarten mit Firmenbezug, die in die Mail gehoeren (ohne Erinnerungen, Workflows, Importe). */
const ARTEN: Partial<Record<AlertKind, string>> = {
  publication: "Veröffentlichung",
  "financial-delta": "Finanzen",
  "profile-change": "Stammdaten",
  "evaluation-flag": "Hinweis",
  "linkedin-signal": "LinkedIn",
  "link-change": "Website",
  "radar-match": "Radar",
  status: "Firmenstatus",
  "contact-change": "Ansprechpartner",
  "customer-change": "Kunden",
  "job-posting": "Stellen",
  "fokus-thema": "Fokus-Thema",
};

const HOECHSTENS = 30;
const RANG: Record<Alert["severity"], number> = { urgent: 0, warn: 1, info: 2 };

export function mailMeldungen(alle: Alert[], bis: string): Alert[] {
  return alle
    .filter((a) => a.createdAt > bis && a.seenAt === null && a.dismissedAt === null && !!a.companyId && !!ARTEN[a.kind])
    .sort((x, y) => RANG[x.severity] - RANG[y.severity] || (x.createdAt < y.createdAt ? 1 : -1))
    .slice(0, HOECHSTENS);
}

export const vormonatKennung = (jetzt: Date): string => {
  const d = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** Beitragszeile fuer die Mail: nur der Vormonat, nur wenn der Rechner etwas beigetragen hat. */
export function beitragFuerMail(b: MithelfenBeitrag | null, vormonat: string): { monat: string; abfragen: number; aenderungen: number } | null {
  if (!b || b.vormonat.monat !== vormonat || b.vormonat.abfragen <= 0) return null;
  return { monat: vormonat, abfragen: b.vormonat.abfragen, aenderungen: b.vormonat.neu + b.vormonat.geaendert };
}

export async function neuigkeitenMailPruefen(deps: {
  gateway: GatewayClient;
  meldungen: () => Alert[];
  datei?: string;
  jetzt?: () => Date;
  /** Burggraben 4: eigener Mithelfen-Beitrag (Gateway); fehlt er, geht die Mail ohne die Zeile. */
  beitrag?: () => Promise<MithelfenBeitrag | null>;
}): Promise<void> {
  const datei = deps.datei ?? onboardingDatei();
  const jetztDatum = (deps.jetzt ?? (() => new Date()))();
  const jetzt = jetztDatum.toISOString();
  const marke = markeLesen(datei);
  const bis = marke.neuigkeitenBis;
  // Erster Lauf: ab jetzt zaehlen, keine alten Meldungen nachschicken.
  if (!bis) { markeSetzen(datei, { neuigkeitenBis: jetzt }); return; }
  const auswahl = mailMeldungen(deps.meldungen(), bis);
  if (auswahl.length === 0) return;
  const vormonat = vormonatKennung(jetztDatum);
  let beitrag: { monat: string; abfragen: number; aenderungen: number } | null = null;
  let beitragGeprueft = false;
  if (deps.beitrag && marke.beitragGemeldet !== vormonat) {
    try {
      beitrag = beitragFuerMail(await deps.beitrag(), vormonat);
      beitragGeprueft = true;
    } catch {
      /* ohne Zeile, naechster Takt versucht es erneut */
    }
  }
  const r = await deps.gateway.request<{ gesendet?: boolean; grund?: string }>("/v1/onboarding/mail/neuigkeiten", {
    method: "POST",
    body: {
      meldungen: auswahl.map((a) => ({
        firma: a.companyName.slice(0, 200),
        titel: a.headline.slice(0, 200),
        text: a.rationale.slice(0, 600),
        art: ARTEN[a.kind]!,
        quelleUrl: a.url ?? a.quellen?.[0]?.url ?? null,
        companyId: a.companyId,
      })),
      ...(beitrag ? { beitrag } : {}),
    },
  });
  // Gesendet oder keine Zustimmung: erledigt (ohne Zustimmung nie nachschicken).
  // "zu frueh" und Fehler: beim naechsten Takt erneut, dann mit allen bis dahin neuen Meldungen.
  if (r.gesendet || r.grund === "keine Zustimmung" || r.grund === "abgemeldet") {
    markeSetzen(datei, { neuigkeitenBis: jetzt, ...(r.gesendet && beitragGeprueft ? { beitragGemeldet: vormonat } : {}) });
  }
}
