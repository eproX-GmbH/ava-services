// O5 (docs/PLAN_ONBOARDING.md): Neuigkeiten per Mail. Ungelesene neue Meldungen zu Firmen
// gehen gesammelt an das Gateway; das versendet nur mit bestaetigter Zustimmung
// (Double-Opt-in aus der Willkommensmail) und hoechstens eine Mail je 20 Stunden.
// Die Marke neuigkeitenBis haelt fest, bis wohin Meldungen erledigt sind.

import type { GatewayClient } from "../agent/gateway-client";
import type { Alert, AlertKind } from "../../shared/types";
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

export async function neuigkeitenMailPruefen(deps: { gateway: GatewayClient; meldungen: () => Alert[]; datei?: string; jetzt?: () => Date }): Promise<void> {
  const datei = deps.datei ?? onboardingDatei();
  const jetzt = (deps.jetzt ?? (() => new Date()))().toISOString();
  const bis = markeLesen(datei).neuigkeitenBis;
  // Erster Lauf: ab jetzt zaehlen, keine alten Meldungen nachschicken.
  if (!bis) { markeSetzen(datei, { neuigkeitenBis: jetzt }); return; }
  const auswahl = mailMeldungen(deps.meldungen(), bis);
  if (auswahl.length === 0) return;
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
    },
  });
  // Gesendet oder keine Zustimmung: erledigt (ohne Zustimmung nie nachschicken).
  // "zu frueh" und Fehler: beim naechsten Takt erneut, dann mit allen bis dahin neuen Meldungen.
  if (r.gesendet || r.grund === "keine Zustimmung" || r.grund === "abgemeldet") markeSetzen(datei, { neuigkeitenBis: jetzt });
}
