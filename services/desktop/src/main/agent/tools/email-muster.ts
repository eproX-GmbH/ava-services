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
    ...(e.baseline ? { baseline: e.baseline } : {}),
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
      "(Server nimmt jede Adresse an) nach Muster als „abgeleitet · unbestaetigt“ mit niedrigerer Zuverlaessigkeit — eine Antwort bestaetigt, ein Bounce entfernt sie. " +
      "Stufe 2: Firmenadressen mit Namen (pdettlev@…) werden Personen zugeordnet (zuordnungAktiv); ohne moegliche Pruefung (Port 25) bekommen trotzdem ALLE Personen eine Adresse, " +
      "gekennzeichnet „abgeleitet · unverifiziert“ mit Baseline (ungeprueftAnzeigen), spaeter nachgeprueft.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: Record<string, any>) => `E-Mail-Ableitung ${r.enabled ? "aktiv" : "aus"} · ${r.stats?.verifiziert ?? 0} verifiziert`,
    run: async () => {
      const s = svc().status();
      return {
        enabled: s.enabled,
        zuordnungAktiv: s.zuordnungAktiv !== false,
        ungeprueftAnzeigen: s.ungeprueftAnzeigen !== false,
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
      "(verifiziert / zugeordnet = Firmenadresse der Person zugeordnet / abgelehnt / unklar = unverifiziert gespeichert / catch_all = unbestaetigt gespeichert / gesperrt), die Baseline-Adresse und ob die Adresse am Server gespeichert wurde. Optional filterbar nach Ergebnis " +
      "(nur = verifiziert|zugeordnet|abgelehnt|unklar|catch_all|gesperrt|gespeichert) oder Firma (companyId).",
    parameters: {
      type: "object",
      properties: {
        nur: { type: "string", enum: ["verifiziert", "zugeordnet", "abgelehnt", "unklar", "catch_all", "gesperrt", "gespeichert"] },
        companyId: { type: "string" },
        limit: { type: "number", description: "max. Eintraege (Standard 30)" },
      },
    },
    schema: yup
      .object({
        nur: yup.string().oneOf(["verifiziert", "zugeordnet", "abgelehnt", "unklar", "catch_all", "gesperrt", "gespeichert"]).optional(),
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
    summary: "E-Mail-Ableitung einstellen: ein/aus, Zuordnung von Firmenadressen, unverifizierte Ableitungen anzeigen (mit Bestaetigung).",
    category: "kontakte email adresse muster einstellung zuordnung unverifiziert",
    description:
      "Aendert Einstellungen der lokalen Hintergrund-Ableitung von E-Mail-Adressen: enabled (ein/aus), zuordnungAktiv (Firmenadressen mit Namen per Namensabgleich/KI-Urteil Personen zuordnen), " +
      "ungeprueftAnzeigen (Adressen auch speichern, wenn die Mail-Pruefung nicht moeglich war oder ablehnte — klar als unverifiziert/abgelehnt gekennzeichnet). Mindestens ein Feld angeben. Fragt vor der Aenderung nach.",
    parameters: { type: "object", properties: { enabled: { type: "boolean" }, zuordnungAktiv: { type: "boolean" }, ungeprueftAnzeigen: { type: "boolean" } } },
    schema: yup.object({ enabled: yup.boolean().optional(), zuordnungAktiv: yup.boolean().optional(), ungeprueftAnzeigen: yup.boolean().optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.abgebrochen ? "abgebrochen" : r.hinweis ? String(r.hinweis) : `E-Mail-Ableitung ${r.enabled ? "aktiv" : "aus"} · Zuordnung ${r.zuordnungAktiv ? "an" : "aus"} · unverifiziert ${r.ungeprueftAnzeigen ? "sichtbar" : "verborgen"}`),
    run: async (args, c) => {
      const patch: { enabled?: boolean; zuordnungAktiv?: boolean; ungeprueftAnzeigen?: boolean } = {};
      if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
      if (typeof args.zuordnungAktiv === "boolean") patch.zuordnungAktiv = args.zuordnungAktiv;
      if (typeof args.ungeprueftAnzeigen === "boolean") patch.ungeprueftAnzeigen = args.ungeprueftAnzeigen;
      if (Object.keys(patch).length === 0) return { hinweis: "Kein Feld angegeben (enabled, zuordnungAktiv, ungeprueftAnzeigen)." };
      const saetze = [
        patch.enabled === true ? "E-Mail-Ableitung einschalten? AVA leitet dann im Hintergrund Adressen fuer Kontakte ohne E-Mail ab und prueft sie per Mail-Server-Anfrage (ohne Zustellung)." : patch.enabled === false ? "E-Mail-Ableitung ausschalten?" : "",
        patch.zuordnungAktiv === true ? "Firmenadressen mit Namen kuenftig Personen zuordnen (mit KI-Urteil)?" : patch.zuordnungAktiv === false ? "Zuordnung von Firmenadressen ausschalten?" : "",
        patch.ungeprueftAnzeigen === true ? "Unverifizierte Ableitungen kuenftig speichern und anzeigen (gekennzeichnet)?" : patch.ungeprueftAnzeigen === false ? "Unverifizierte Ableitungen nicht mehr speichern?" : "",
      ].filter(Boolean);
      const value = await c.ui.confirmAction(
        { kind: "mutating", prompt: saetze.join(" "), confirmValue: "ja", options: [{ value: "ja", label: "Uebernehmen" }, { value: "nein", label: "Abbrechen" }] },
        c.signal,
      );
      if (value !== "ja") return { abgebrochen: true };
      const cfg = svc().setConfig(patch);
      return { enabled: cfg.enabled, zuordnungAktiv: cfg.zuordnungAktiv !== false, ungeprueftAnzeigen: cfg.ungeprueftAnzeigen !== false };
    },
  });

  const vorschau = defineTool({
    name: "email_muster_vorschau",
    summary: "Fuer eine Firma zeigen, welches Adressmuster erkennbar ist und welche Adressen AVA ableiten wuerde (ohne Pruefung).",
    category: "kontakte email adresse muster vorschau trockenlauf",
    description:
      "Trockenlauf ohne Netzverkehr: erkennt aus den bekannten Personen-E-Mails der Firma das Adressmuster (Baseline) und listet die Kandidaten-Adressen " +
      "fuer Kontakte ohne E-Mail sowie Firmenadressen, die per Namensabgleich einer Person zugeordnet wuerden. Es wird nichts gespeichert; die echte Ableitung mit Mail-Pruefung uebernimmt der Hintergrund-Job (oder email_muster_jetzt).",
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

  // V5 (docs/PLAN_CHAT_DATEIEN_KONTEXT.md): Funktionsadressen pruefen.
  const adressePruefen = defineTool({
    name: "email_adresse_pruefen",
    summary: "Frei gewaehlte Adressen an der Firmendomain per Mail-Server-Anfrage pruefen (z. B. rechnung@, buchhaltung@, bewerbung@).",
    category: "kontakte email adresse rechnung buchhaltung pruefen",
    description:
      "Prueft bis zu 10 Lokalteile (ohne @) an der Domain der Firma per SMTP-Anfrage, ohne eine Mail zu senden. Ergebnis je Adresse: existiert, existiert_nicht, unbekannt, catch_all (Server nimmt alles an, kein Beleg), gesperrt. " +
      "Nutze es, wenn der Nutzer eine Adresse braucht, die nicht vorliegt (Rechnung, Buchhaltung, Bewerbung, Presse). Dauert einige Sekunden. Nichts wird gespeichert.",
    parameters: {
      type: "object",
      required: ["companyId", "lokalteile"],
      properties: {
        companyId: { type: "string" },
        lokalteile: { type: "array", items: { type: "string" }, description: "z. B. [\"rechnung\", \"buchhaltung\", \"invoice\", \"accounting\"]" },
      },
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required(), lokalteile: yup.array().of(yup.string().trim().min(1).max(40).required()).min(1).max(10).required() }).noUnknown(true),
    preview: (r: Record<string, any>) => {
      const e = (r.ergebnisse ?? []) as Array<{ ergebnis: string }>;
      const ok = e.filter((x) => x.ergebnis === "existiert").length;
      return r.domain ? `${ok} von ${e.length} Adressen belegt (@${r.domain})` : String(r.hinweis ?? "keine Domain");
    },
    run: async (args) => svc().pruefeLokalteile(args.companyId, args.lokalteile),
  });
  return [status, verlauf, config, vorschau, jetzt, adressePruefen];
}
