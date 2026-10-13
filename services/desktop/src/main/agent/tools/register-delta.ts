// Register-Delta S6 — Chat-Tools fuer "Mithelfen": Status lesen, Einstellung
// aendern (mit Bestaetigung, Self-Service-Regel).

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { MithelfenSupervisor } from "../../register-delta/supervisor";
import type { GatewayClient } from "../gateway-client";
import { workerModus } from "../../worker-modus";

const GRUND_TEXT: Record<string, string> = {
  aus: "ausgeschaltet",
  organisation: "von der Organisation abgeschaltet",
  abgemeldet: "nicht angemeldet",
  akku: "Akkubetrieb (nur im Netzbetrieb aktiv)",
  nicht_installiert: "Worker nicht installiert",
  gesperrt: "Registerportal hat die Abfragen vorübergehend gesperrt",
};

export function buildRegisterDeltaTools(deps: {
  get: () => MithelfenSupervisor | null;
  /** Gateway fuer die Uebernahme von Live-Suchtreffern in die Stammdaten. */
  gateway?: GatewayClient;
  queueStatus: () => Promise<Record<string, unknown> | null>;
  /** Zustand des eigenen Browsers (Chrome for Testing). */
  browserStand?: () => { zustand: string; version?: string; fortschritt?: number; meldung?: string };
  /** Eigenen Browser laden, falls er fehlt. */
  browserLaden?: () => Promise<{ zustand: string; version?: string; meldung?: string }>;
}): Tool[] {
  const status = defineTool({
    name: "register_delta_status",
    summary: "Stammdaten mitpflegen: Status des lokalen Register-Workers und der geteilten Job-Queue.",
    category: "stammdaten mithelfen register handelsregister worker queue status aktualisierung",
    description:
      "Zeigt, ob dieser Rechner Register-Jobs abarbeitet (Nummernfront neuer Firmen, Registerbekanntmachungen, Auffrischung bekannter Firmen), " +
      "warum er gerade pausiert, welchen Job er bearbeitet, wie viele Abfragen in der letzten Stunde liefen (Budget 60), und den Stand der " +
      "geteilten Queue (offene und erledigte Jobs, aktive Worker). Nur lesend.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : r.lokal?.laeuft ? "Mithelfen aktiv" : `Mithelfen pausiert: ${r.lokal?.pausenText ?? "-"}`),
    run: async () => {
      const sup = deps.get();
      if (!sup) return { error: "Mithelfen noch nicht initialisiert." };
      const s = sup.status();
      const queue = await deps.queueStatus();
      return { lokal: { ...s, pausenText: s.pausenGrund ? GRUND_TEXT[s.pausenGrund] : null }, queue };
    },
  });
  const config = defineTool({
    name: "register_delta_config",
    summary: "Stammdaten mitpflegen ein-/ausschalten, Akku schonen oder den Worker-Modus setzen (mit Bestaetigung).",
    category: "stammdaten mithelfen einstellung register worker netzbetrieb akku worker-modus nur handelsregister",
    description:
      "Liest oder aendert die Einstellung: aktiv = dieser Rechner arbeitet Register-Jobs der Organisation ab (Handelsregister-Abfragen mit der " +
      "eigenen IP, hoechstens 60 je Stunde, Chrome im Hintergrund), nurNetzbetrieb = auf Akku pausieren, nurRegister = Worker-Modus: AVA " +
      "verarbeitet dann ausschliesslich Handelsregister-Jobs, alles andere (Herzschlag, Vorgaenge, Producer, Ablaeufe, Mail, Radar) ruht. " +
      "Ohne Argumente: aktuelle Werte. Schaltet die Organisation die Funktion ab, gilt das vorrangig.",
    parameters: { type: "object", properties: { aktiv: { type: "boolean" }, nurNetzbetrieb: { type: "boolean" }, nurRegister: { type: "boolean" } } },
    schema: yup.object({ aktiv: yup.boolean().optional(), nurNetzbetrieb: yup.boolean().optional(), nurRegister: yup.boolean().optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : r.geaendert ? "Mithelfen-Einstellung geaendert" : "Mithelfen-Einstellung gelesen"),
    run: async (args, c) => {
      const sup = deps.get();
      if (!sup) return { error: "Mithelfen noch nicht initialisiert." };
      if (args.aktiv === undefined && args.nurNetzbetrieb === undefined && args.nurRegister === undefined) return { geaendert: false, ...sup.status() };
      const teile: string[] = [];
      if (args.aktiv !== undefined) teile.push(`Mithelfen → ${args.aktiv ? "an" : "aus"}`);
      if (args.nurNetzbetrieb !== undefined) teile.push(`nur Netzbetrieb → ${args.nurNetzbetrieb ? "an" : "aus"}`);
      if (args.nurRegister !== undefined) teile.push(`Worker-Modus (nur Handelsregister, alles andere ruht) → ${args.nurRegister ? "an" : "aus"}`);
      const value = await c.ui.confirmAction(
        { kind: "additive", prompt: `Stammdaten mitpflegen ändern: ${teile.join(", ")}?`, confirmValue: "ja", options: [{ value: "ja", label: "Ändern" }, { value: "nein", label: "Abbrechen" }] },
        c.signal,
      );
      if (value !== "ja") return { geaendert: false, abgebrochen: true };
      const next = sup.setSettings({
        ...(args.aktiv !== undefined ? { aktiv: args.aktiv } : {}),
        ...(args.nurNetzbetrieb !== undefined ? { nurNetzbetrieb: args.nurNetzbetrieb } : {}),
        ...(args.nurRegister !== undefined ? { nurRegister: args.nurRegister } : {}),
      });
      // Der Worker-Modus haelt die uebrigen Hintergrunddienste an oder laesst
      // sie wieder anlaufen; ohne diesen Schritt bliebe nur der Schalter gesetzt.
      if (args.nurRegister !== undefined) await workerModus.setzen(args.nurRegister === true);
      return { geaendert: true, ...sup.status(), ...(args.nurRegister !== undefined ? { ruhendeDienste: args.nurRegister ? workerModus.angemeldet() : [] } : {}) };
    },
  });
  const browser = defineTool({
    name: "browser_status",
    summary: "Eigener Browser der Hintergrundverarbeitung: Zustand lesen, bei Bedarf laden.",
    category: "browser chrome hintergrund verarbeitung handelsregister webseiten eigener browser",
    description:
      "AVA steuert fuer Handelsregister, Webseiten und Publikationen einen eigenen Browser im Hintergrund (Chrome for Testing, rund 160 MB, " +
      "einmalig geladen). Der Browser der Person wird dabei nie gestartet, nie beendet und teilt weder Profil noch Anmeldungen. " +
      "Ohne Argumente: aktueller Zustand. Mit laden=true wird eine fehlende Fassung geholt (mit Bestaetigung, weil es Daten kostet). " +
      "Fehlt die Fassung, arbeitet AVA mit dem Browser, der auf dem Rechner installiert ist.",
    parameters: { type: "object", properties: { laden: { type: "boolean", description: "Fehlende Fassung jetzt laden." } } },
    schema: yup.object({ laden: yup.boolean().optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : r.zustand === "bereit" ? `eigener Browser bereit (${r.version ?? "?"})` : `eigener Browser: ${r.zustand}`),
    run: async (args, c) => {
      const stand = deps.browserStand?.();
      if (!stand) return { error: "Der eigene Browser ist in dieser Installation nicht eingerichtet." };
      if (!args.laden) return stand;
      if (stand.zustand === "bereit") return { ...stand, hinweis: "Die Fassung liegt bereits bereit." };
      if (!deps.browserLaden) return { ...stand, error: "Laden ist hier nicht moeglich." };
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: "Eigenen Browser fuer die Hintergrundverarbeitung laden? Rund 160 MB, einmalig.",
          confirmValue: "ja",
          options: [
            { value: "ja", label: "Laden" },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "ja") return { ...stand, abgebrochen: true };
      return await deps.browserLaden();
    },
  });
  // docs/PLAN_FIRMEN_OHNE_REGISTER.md F2: Firma nicht in den Stammdaten → live
  // im Registerportal nach dem Namen suchen (Browser des Nutzers, eigene IP),
  // Treffer in die Stammdaten uebernehmen, companyIds fuer den Import liefern.
  const liveSuche = defineTool({
    name: "register_live_suche",
    summary: "Firma live im Handelsregister nach Namen suchen, wenn company_search nichts findet; Treffer kommen in die Stammdaten und sind sofort importierbar.",
    category: "handelsregister live suche stammdaten nicht gefunden firma anlegen",
    description:
      "Sucht im Registerportal (handelsregister.de) nach einem Firmennamen — nur, wenn company_search KEINEN passenden Treffer hatte. " +
      "Nutzt den eigenen Browser des Nutzers (eigene IP, 30–90 s). Alle Schlagwoerter muessen im Firmennamen vorkommen; mit exakt=true die genaue Bezeichnung. " +
      "Treffer werden in die Stammdaten uebernommen und kommen mit companyId zurueck: GENAU EIN passender Treffer (oder einer mit ortTreffer=true) → sofort import_companies mit companyIds, ohne Rueckfrage. " +
      "Mehrere plausible Treffer → ask_user_choice (Name + Sitz). Kein Treffer → als naechstes firma_finden (Google-Eintrag mit eigener Website), nicht 'nicht gefunden' sagen.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Firmenname oder die wichtigsten Namensbestandteile (ohne Rechtsform ist oft besser)." },
        ort: { type: "string", description: "Optional: Sitz/Stadt — markiert passende Treffer (ortTreffer), filtert nicht." },
        exakt: { type: "boolean", description: "Genaue Firmenbezeichnung statt Schlagwortsuche." },
      },
      required: ["name"],
    },
    schema: yup.object({ name: yup.string().trim().min(2).max(200).required(), ort: yup.string().trim().max(100).optional(), exakt: yup.boolean().optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? `Fehler: ${String(r.error).slice(0, 60)}` : `${r.firmen?.length ?? 0} Treffer im Registerportal`),
    run: async (args) => {
      const sup = deps.get();
      if (!sup) return { error: "Register-Worker noch nicht initialisiert." };
      if (!deps.gateway) return { error: "Gateway nicht verfuegbar." };
      const a = await sup.sucheLive(args.name, args.ort ?? null, args.exakt === true);
      if ("fehler" in a) return { error: `Registerportal: ${a.fehler}` };
      if (a.gesperrt) return { error: "Das Registerportal hat die Abfragen vorübergehend gesperrt — in einer Stunde erneut versuchen." };
      if (a.treffer.length === 0) return { firmen: [], trefferRoh: a.trefferRoh ?? 0, hinweis: "Kein Registertreffer. Naechster Schritt: firma_finden (Google-Eintrag mit eigener Website)." };
      // Hoechstens 25 Treffer uebernehmen, passende Orte zuerst.
      const sortiert = [...a.treffer].sort((x, y) => Number(y.ortTreffer === true) - Number(x.ortTreffer === true)).slice(0, 25);
      const r = await deps.gateway.request<{ neu: number; geaendert: number; firmen: Array<{ companyId: string; name: string; sitz: string; status: string }> }>(
        "/v1/register-jobs/treffer",
        { method: "POST", body: { treffer: sortiert.map(({ ortTreffer: _o, statusText: _s, ...t }) => t) } },
      );
      const firmen = r.firmen.map((f, i) => ({ ...f, ortTreffer: sortiert[i]?.ortTreffer ?? null, ...(f.status !== "ACTIVE" ? { statusWarnung: "Registerblatt geschlossen oder Loeschung angekuendigt" } : {}) }));
      const passend = firmen.filter((f) => f.ortTreffer !== false && f.status === "ACTIVE");
      return {
        firmen,
        trefferRoh: a.trefferRoh ?? firmen.length,
        neuInStammdaten: r.neu,
        hinweis:
          passend.length === 1
            ? `Ein passender Treffer: jetzt import_companies mit companyIds=["${passend[0]!.companyId}"] aufrufen, ohne Rueckfrage.`
            : passend.length === 0
              ? "Kein aktiver, zum Ort passender Treffer — Kandidaten dem Nutzer nennen oder firma_finden versuchen."
              : "Mehrere plausible Treffer: per ask_user_choice (Name + Sitz) klaeren, dann import_companies.",
      };
    },
  });
  return [status, config, browser, liveSuche];
}
