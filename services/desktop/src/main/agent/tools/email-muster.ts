// Chat-Tools der E-Mail-Ableitung (Self-Service-Regel: jede Einstellung hat
// ein Tool mit confirmAction). Seit 2026-10-12 ohne Hintergrund-Job: die
// Verifizierung laeuft als Pipeline-Stufe „E-Mail“ je Firma (Producer
// company-email, docs/PLAN_EMAIL_VERIFIZIERUNG.md); Stand und Wiederholung
// gehen ueber die Status-Matrix bzw. retry_stage.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { EmailMusterDienst } from "../../contacts/email-muster/dienst";

export function buildEmailMusterTools(deps: { get: () => EmailMusterDienst | null }): Tool[] {
  const svc = (): EmailMusterDienst => {
    const s = deps.get();
    if (!s) throw new Error("E-Mail-Ableitung noch nicht initialisiert.");
    return s;
  };

  const status = defineTool({
    name: "email_muster_status",
    summary: "Einstellungen der E-Mail-Ableitung (Adressmuster + Mail-Pruefung) anzeigen.",
    category: "kontakte email adresse muster ableitung verifizierung",
    description:
      "Zeigt die Schalter der E-Mail-Ableitung: ein/aus, Zuordnung von Firmenadressen, unverifizierte Ableitungen anzeigen. " +
      "Die Ableitung selbst laeuft je Firma als Pipeline-Stufe „E-Mail“ direkt nach dem Kontaktlauf (lokal, Producer company-email): " +
      "Adressmuster aus Belegen/KI-Urteil, dann wird JEDE abgeleitete Adresse einzeln per Mail-Server-Anfrage geprueft (ohne Zustellung, ohne Tages-Deckel). " +
      "Ergebnis je Adresse: „abgeleitet · verifiziert“ (gruen), „unbestaetigt“ (Catch-all), „unverifiziert“ (Pruefung nicht moeglich) oder „vom Server abgelehnt“. " +
      "pruefungenJeStunde = Verifizierungsrate dieser Person (RCPT-TO-Anfragen je Stunde, Standard 300, 10–3600); ist sie erreicht, wartet der Lauf. " +
      "Stand je Firma: Status-Matrix (company_get bereich aenderungen bzw. retry_stage fuer eine Wiederholung).",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: Record<string, any>) => `E-Mail-Ableitung ${r.enabled ? "aktiv" : "aus"}`,
    run: async () => {
      const s = svc().getConfig();
      return {
        enabled: s.enabled,
        zuordnungAktiv: s.zuordnungAktiv !== false,
        ungeprueftAnzeigen: s.ungeprueftAnzeigen !== false,
        pruefungenJeStunde: s.pruefungenJeStunde ?? 300,
        hinweis: "Die Verifizierung laeuft als Pipeline-Stufe „E-Mail“ je Firma; eine Wiederholung stoesst retry_stage (stage companyEmail) an.",
      };
    },
  });

  const config = defineTool({
    name: "email_muster_config",
    summary: "E-Mail-Ableitung einstellen: ein/aus, Zuordnung von Firmenadressen, unverifizierte Ableitungen anzeigen, Verifizierungsrate je Stunde (mit Bestaetigung).",
    category: "kontakte email adresse muster einstellung zuordnung unverifiziert",
    description:
      "Aendert Einstellungen der E-Mail-Ableitung: enabled (ein/aus), zuordnungAktiv (Firmenadressen mit Namen per Namensabgleich/KI-Urteil Personen zuordnen), " +
      "ungeprueftAnzeigen (Adressen auch speichern, wenn die Mail-Pruefung nicht moeglich war oder ablehnte — klar als unverifiziert/abgelehnt gekennzeichnet), " +
      "pruefungenJeStunde (Verifizierungsrate dieser Person: RCPT-TO-Anfragen je Stunde, 10–3600, Standard 300; hoeher = schneller, aber mehr Last auf fremden Mailservern). Mindestens ein Feld angeben. Fragt vor der Aenderung nach.",
    parameters: { type: "object", properties: { enabled: { type: "boolean" }, zuordnungAktiv: { type: "boolean" }, ungeprueftAnzeigen: { type: "boolean" }, pruefungenJeStunde: { type: "number" } } },
    schema: yup.object({ enabled: yup.boolean().optional(), zuordnungAktiv: yup.boolean().optional(), ungeprueftAnzeigen: yup.boolean().optional(), pruefungenJeStunde: yup.number().integer().min(10).max(3600).optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.abgebrochen ? "abgebrochen" : r.hinweis ? String(r.hinweis) : `E-Mail-Ableitung ${r.enabled ? "aktiv" : "aus"} · Zuordnung ${r.zuordnungAktiv ? "an" : "aus"} · unverifiziert ${r.ungeprueftAnzeigen ? "sichtbar" : "verborgen"} · ${r.pruefungenJeStunde} Pruefungen/h`),
    run: async (args, c) => {
      const patch: { enabled?: boolean; zuordnungAktiv?: boolean; ungeprueftAnzeigen?: boolean; pruefungenJeStunde?: number } = {};
      if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
      if (typeof args.zuordnungAktiv === "boolean") patch.zuordnungAktiv = args.zuordnungAktiv;
      if (typeof args.ungeprueftAnzeigen === "boolean") patch.ungeprueftAnzeigen = args.ungeprueftAnzeigen;
      if (typeof args.pruefungenJeStunde === "number") patch.pruefungenJeStunde = args.pruefungenJeStunde;
      if (Object.keys(patch).length === 0) return { hinweis: "Kein Feld angegeben (enabled, zuordnungAktiv, ungeprueftAnzeigen, pruefungenJeStunde)." };
      const saetze = [
        patch.enabled === true ? "E-Mail-Ableitung einschalten? AVA leitet dann bei jedem Kontaktlauf Adressen fuer Kontakte ohne E-Mail ab und prueft jede per Mail-Server-Anfrage (ohne Zustellung)." : patch.enabled === false ? "E-Mail-Ableitung ausschalten?" : "",
        patch.zuordnungAktiv === true ? "Firmenadressen mit Namen kuenftig Personen zuordnen (mit KI-Urteil)?" : patch.zuordnungAktiv === false ? "Zuordnung von Firmenadressen ausschalten?" : "",
        patch.ungeprueftAnzeigen === true ? "Unverifizierte Ableitungen kuenftig speichern und anzeigen (gekennzeichnet)?" : patch.ungeprueftAnzeigen === false ? "Unverifizierte Ableitungen nicht mehr speichern?" : "",
        patch.pruefungenJeStunde !== undefined ? `Verifizierungsrate auf ${patch.pruefungenJeStunde} Mail-Server-Anfragen je Stunde setzen?` : "",
      ].filter(Boolean);
      const value = await c.ui.confirmAction(
        { kind: "mutating", prompt: saetze.join(" "), confirmValue: "ja", options: [{ value: "ja", label: "Uebernehmen" }, { value: "nein", label: "Abbrechen" }] },
        c.signal,
      );
      if (value !== "ja") return { abgebrochen: true };
      const cfg = svc().setConfig(patch);
      return { enabled: cfg.enabled, zuordnungAktiv: cfg.zuordnungAktiv !== false, ungeprueftAnzeigen: cfg.ungeprueftAnzeigen !== false, pruefungenJeStunde: cfg.pruefungenJeStunde ?? 300 };
    },
  });

  const vorschau = defineTool({
    name: "email_muster_vorschau",
    summary: "Fuer eine Firma zeigen, welches Adressmuster erkennbar ist und welche Adressen AVA ableiten wuerde (ohne Pruefung).",
    category: "kontakte email adresse muster vorschau trockenlauf",
    description:
      "Trockenlauf ohne Netzverkehr: erkennt aus den bekannten Personen-E-Mails der Firma das Adressmuster (Baseline) und listet die Kandidaten-Adressen " +
      "fuer Kontakte ohne E-Mail sowie Firmenadressen, die per Namensabgleich einer Person zugeordnet wuerden. Es wird nichts gespeichert; die echte Ableitung mit Mail-Pruefung ist die Pipeline-Stufe „E-Mail“ (Wiederholung: retry_stage mit stage companyEmail).",
    parameters: { type: "object", required: ["companyId"], properties: { companyId: { type: "string" } } },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.befund?.muster ? `Muster ${r.befund.muster} · ${r.kandidaten?.length ?? 0} Kandidaten` : (r.hinweis ?? "kein Muster")),
    run: async (args) => svc().vorschau(args.companyId),
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
  return [status, config, vorschau, adressePruefen];
}
