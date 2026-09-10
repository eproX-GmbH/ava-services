// M4 (docs/PLAN_EMAIL_MUSTER.md) — Chat-Tools fuer die lokale E-Mail-Ableitung
// (Self-Service-Regel: jede Einstellung hat ein Tool mit confirmAction).

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { EmailMusterSupervisor } from "../../contacts/email-muster/supervisor";
import type { VerlaufEintrag } from "../../../shared/email-muster-types";

export function buildEmailMusterTools(deps: { get: () => EmailMusterSupervisor | null }): Tool[] {
  const svc = (): EmailMusterSupervisor => {
    const s = deps.get();
    if (!s) throw new Error("E-Mail-Ableitung noch nicht initialisiert.");
    return s;
  };

  const kurz = (e: VerlaufEintrag) => ({
    at: e.at,
    firma: e.firma,
    companyId: e.companyId,
    person: e.fullName,
    email: e.email,
    muster: e.muster,
    ergebnis: e.ergebnis,
    gespeichert: e.gespeichert,
    ...(e.smtpCode ? { smtpCode: e.smtpCode } : {}),
    ...(e.fehler ? { fehler: e.fehler } : {}),
  });

  const status = defineTool({
    name: "email_muster_status",
    summary: "Stand der lokalen E-Mail-Ableitung (Adressmuster + Mail-Pruefung) anzeigen.",
    category: "kontakte email adresse muster ableitung verifizierung",
    description:
      "Zeigt, ob die Hintergrund-Ableitung von E-Mail-Adressen aktiv ist, ob die Mail-Pruefung in diesem Netz moeglich ist (Port 25), " +
      "wann zuletzt gelaufen und wie viele Adressen abgeleitet und verifiziert wurden. Die Ableitung laeuft lokal auf diesem Rechner, " +
      "eine Firma je Durchgang, nur wenn kein Chat laeuft. Verifizierte Adressen werden als „abgeleitet · verifiziert“ gespeichert; bei Catch-all-Domains " +
      "(Server nimmt jede Adresse an) nach Muster als „abgeleitet · unbestaetigt“ mit niedrigerer Zuverlaessigkeit — eine Antwort bestaetigt, ein Bounce entfernt sie.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: Record<string, any>) => `E-Mail-Ableitung ${r.enabled ? "aktiv" : "aus"} · ${r.stats?.verifiziert ?? 0} verifiziert`,
    run: async () => {
      const s = svc().status();
      return {
        enabled: s.enabled,
        laeuft: s.laeuft,
        netz: s.netz ? (s.netz.erreichbar ? "Mail-Pruefung moeglich" : `Mail-Pruefung in diesem Netz nicht moeglich (${s.netz.grund})`) : "noch nicht geprueft",
        lastRunAt: s.lastRunAt,
        lastOutcome: s.lastOutcome,
        heute: s.tag,
        stats: s.stats,
        domainsGeprueft: Object.keys(s.domains).length,
        letztePruefungen: svc().verlauf({ limit: 10 }).map(kurz),
        hinweis: "Vollstaendiger Verlauf je Adresse: email_muster_verlauf oder Einstellungen → Automatisierungen → E-Mail-Ableitung.",
      };
    },
  });

  const verlauf = defineTool({
    name: "email_muster_verlauf",
    summary: "Verlauf der E-Mail-Ableitung: welche Adresse wann geprueft, verifiziert und gespeichert wurde.",
    category: "kontakte email adresse muster verlauf historie geprueft verifiziert gespeichert",
    description:
      "Listet die einzelnen Adresspruefungen der lokalen E-Mail-Ableitung, juengste zuerst: Zeitpunkt, Firma, Person, Adresse, Muster, Ergebnis " +
      "(verifiziert / abgelehnt / unklar / catch_all = unbestaetigt gespeichert / gesperrt) und ob die Adresse am Server gespeichert wurde. Optional filterbar nach Ergebnis " +
      "(nur = verifiziert|abgelehnt|unklar|catch_all|gesperrt|gespeichert) oder Firma (companyId).",
    parameters: {
      type: "object",
      properties: {
        nur: { type: "string", enum: ["verifiziert", "abgelehnt", "unklar", "catch_all", "gesperrt", "gespeichert"] },
        companyId: { type: "string" },
        limit: { type: "number", description: "max. Eintraege (Standard 30)" },
      },
    },
    schema: yup
      .object({
        nur: yup.string().oneOf(["verifiziert", "abgelehnt", "unklar", "catch_all", "gesperrt", "gespeichert"]).optional(),
        companyId: yup.string().trim().optional(),
        limit: yup.number().integer().min(1).max(500).optional(),
      })
      .noUnknown(true),
    preview: (r: Record<string, any>) => `${r.eintraege?.length ?? 0} Pruefungen (${r.gesamt ?? 0} gesamt)`,
    run: async (args) => {
      const rows = svc().verlauf({ nur: args.nur as never, companyId: args.companyId || undefined, limit: args.limit ?? 30 });
      return { gesamt: svc().status().verlauf.length, eintraege: rows.map(kurz) };
    },
  });

  const config = defineTool({
    name: "email_muster_config",
    summary: "E-Mail-Ableitung ein-/ausschalten (mit Bestaetigung).",
    category: "kontakte email adresse muster einstellung",
    description: "Schaltet die lokale Hintergrund-Ableitung von E-Mail-Adressen ein oder aus. Fragt vor der Aenderung nach.",
    parameters: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } },
    schema: yup.object({ enabled: yup.boolean().required() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.abgebrochen ? "abgebrochen" : `E-Mail-Ableitung ${r.enabled ? "eingeschaltet" : "ausgeschaltet"}`),
    run: async (args, c) => {
      const value = await c.ui.confirmAction(
        {
          kind: "mutating",
          prompt: args.enabled ? "E-Mail-Ableitung einschalten? AVA leitet dann im Hintergrund Adressen fuer Kontakte ohne E-Mail ab und prueft sie per Mail-Server-Anfrage (ohne Zustellung)." : "E-Mail-Ableitung ausschalten?",
          confirmValue: "ja",
          options: [
            { value: "ja", label: args.enabled ? "Einschalten" : "Ausschalten" },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "ja") return { abgebrochen: true };
      const cfg = svc().setConfig({ enabled: args.enabled });
      return { enabled: cfg.enabled };
    },
  });

  const vorschau = defineTool({
    name: "email_muster_vorschau",
    summary: "Fuer eine Firma zeigen, welches Adressmuster erkennbar ist und welche Adressen AVA ableiten wuerde (ohne Pruefung).",
    category: "kontakte email adresse muster vorschau trockenlauf",
    description:
      "Trockenlauf ohne Netzverkehr: erkennt aus den bekannten Personen-E-Mails der Firma das Adressmuster und listet die Kandidaten-Adressen " +
      "fuer Kontakte ohne E-Mail. Es wird nichts gespeichert; die echte Ableitung mit Mail-Pruefung uebernimmt der Hintergrund-Job (oder email_muster_jetzt).",
    parameters: { type: "object", required: ["companyId"], properties: { companyId: { type: "string" } } },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.befund?.muster ? `Muster ${r.befund.muster} · ${r.kandidaten?.length ?? 0} Kandidaten` : (r.hinweis ?? "kein Muster")),
    run: async (args) => svc().vorschau(args.companyId),
  });

  const jetzt = defineTool({
    name: "email_muster_jetzt",
    summary: "Einen Durchgang der E-Mail-Ableitung sofort starten (eine Firma, mit Mail-Pruefung).",
    category: "kontakte email adresse muster starten",
    description: "Startet sofort einen Durchgang: eine Firma mit Kontakten ohne E-Mail wird geprueft. Dauert bis zu einer Minute.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: Record<string, any>) => String(r.ergebnis ?? ""),
    run: async () => ({ ergebnis: await svc().runNow() }),
  });

  return [status, verlauf, config, vorschau, jetzt];
}
