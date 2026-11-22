// AVA-Server im Chat (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md Z6): Stand des eigenen Servers lesen.
// Nur lesend: Buchen kostet Geld und läuft über den Knopf in der AVA-App (Mehr → Deine AVA),
// Organisationen schalten ihn in der AVA Konsole je Mitglied ein. Ist der Server (noch) nicht
// buchbar und keiner gebucht, sagt das Werkzeug nur das und wirbt für nichts.
import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";

type Zustand = "zahlung_offen" | "wird_angelegt" | "wartet_auf_verbindung" | "laeuft" | "gestoppt" | "ruht";
interface CloudMein {
  server: {
    zustand: Zustand;
    grund: "zahlung" | "kuendigung" | "abbestellt" | "admin" | "betreiber" | "konto" | null;
    abbestelltZum: string | null;
    gestopptAt: string | null;
    loeschenAb: string | null;
    stoerungSeit: string | null;
    wirdAktualisiert: boolean;
    bestaetigen: { link: string; bis: string | null } | null;
    modellGewaehlt: boolean | null;
  } | null;
  buchbar: boolean;
  admin: boolean;
  weg: "buchen" | "kaufen" | "anfragen" | null;
  preis: { serverCents: number; paketCents: number };
}

const APP = "https://app.ava.bi/mehr";
const KONSOLE = "https://admin.ava.bi";
const tag = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Berlin" }) : null);
const euro = (cents: number) => `${(cents / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 })} €`;

/** Satz und nächster Schritt in Nutzersprache (wie die Statuskarte der AVA-App). */
export function serverLage(d: CloudMein): { gebucht: boolean; stand: string; naechsterSchritt: string | null } {
  const s = d.server;
  if (!s) {
    if (!d.buchbar) return { gebucht: false, stand: "Für dieses Konto ist kein AVA-Server gebucht.", naechsterSchritt: null };
    const preis = d.weg === "kaufen" ? `${euro(d.preis.paketCents)} im Monat für Pro und Server zusammen` : `${euro(d.preis.serverCents)} im Monat`;
    return {
      gebucht: false,
      stand: `Kein AVA-Server gebucht. Mit einem Server arbeitet AVA rund um die Uhr, auch wenn der Rechner aus ist (${preis}, zzgl. MwSt., monatlich kündbar).`,
      naechsterSchritt: d.weg === "anfragen" ? `In der AVA-App (${APP}) „Server bei meiner Organisation anfragen“; die Admins bekommen eine Mail.` : `In der AVA-App (${APP}) unter Mehr → Deine AVA „Server buchen“.`,
    };
  }
  const daten = tag(s.loeschenAb) ? ` Die Daten bleiben bis zum ${tag(s.loeschenAb)} erhalten.` : "";
  switch (s.zustand) {
    case "zahlung_offen": return { gebucht: true, stand: "Die Zahlung für den Server wird bestätigt.", naechsterSchritt: null };
    case "wird_angelegt": return { gebucht: true, stand: "Der Server wird gerade eingerichtet (meist 1–3 Minuten).", naechsterSchritt: null };
    case "wartet_auf_verbindung":
      return { gebucht: true, stand: "Der Server läuft und wartet auf die Bestätigung, dass er für dieses Konto arbeiten darf.", naechsterSchritt: s.bestaetigen ? `Bestätigen (ein Klick): ${s.bestaetigen.link}` : `In der AVA-App (${APP}) „Jetzt bestätigen“.` };
    case "laeuft":
      if (s.stoerungSeit) return { gebucht: true, stand: "Der Server ist gerade nicht erreichbar; das Team von AVA ist informiert. Die Daten sind nicht betroffen.", naechsterSchritt: null };
      if (s.wirdAktualisiert) return { gebucht: true, stand: "Der Server wird gerade aktualisiert (wenige Minuten).", naechsterSchritt: null };
      if (s.modellGewaehlt === false) return { gebucht: true, stand: "Der Server läuft, hat aber noch kein KI-Modell.", naechsterSchritt: `In der AVA-App (${APP}) „Modell wählen“.` };
      return { gebucht: true, stand: s.abbestelltZum ? `Der Server läuft, ist aber zum ${tag(s.abbestelltZum)} abbestellt.` : "Der Server läuft rund um die Uhr.", naechsterSchritt: null };
    default: {
      const warum = s.grund === "zahlung" ? "weil die letzte Zahlung nicht eingegangen ist" : s.grund === "kuendigung" ? "weil das Abo der Organisation beendet ist" : s.grund === "abbestellt" ? "weil er abbestellt wurde" : s.grund === "admin" ? "durch die Organisation" : "";
      const schritt = s.grund === "zahlung" || s.grund === "kuendigung"
        ? (d.admin ? `Zahlung bzw. Abo in der AVA Konsole prüfen: ${KONSOLE}/abrechnung` : "Bei der Organisation melden.")
        : s.grund === "abbestellt" && d.admin ? `In der AVA-App (${APP}) „Wieder buchen“.` : s.grund === "admin" ? "Bei der Organisation melden." : null;
      return { gebucht: true, stand: `Der Server ist pausiert${warum ? `, ${warum}` : ""}.${daten}`, naechsterSchritt: schritt };
    }
  }
}

export function buildServerTools(deps: { gateway: GatewayClient }): Tool[] {
  const stand = defineTool({
    name: "server_stand",
    summary: "Stand des eigenen AVA-Servers lesen (läuft, eingerichtet, pausiert, Bestätigung offen) und den nächsten Schritt.",
    category: "server cloud rund um die uhr rechner aus pausiert bestaetigen einrichten",
    description:
      "Liest, ob für den Nutzer ein AVA-Server gebucht ist (AVA läuft dort rund um die Uhr, auch wenn der eigene Rechner aus ist) " +
      "und in welchem Zustand er ist: Zahlung offen, wird eingerichtet, wartet auf Bestätigung, läuft, Störung, Update, pausiert (mit Grund und Löschdatum). " +
      "Liefert einen Satz in Nutzersprache und den nächsten Schritt mit Link. Nur lesend: Buchen und Abbestellen laufen über die AVA-App " +
      "(Mehr → Deine AVA), bei Organisationen über die AVA Konsole. Nicht von dir aus anbieten, nur wenn der Nutzer nach dem Server, " +
      "nach AVA ohne laufenden Rechner oder nach einem Ausfall fragt.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r) => {
      const x = r as { stand?: string; error?: string };
      return x.error ? `Fehler: ${x.error.slice(0, 60)}` : (x.stand ?? "").slice(0, 80);
    },
    run: async (_args, c) => {
      const d = await deps.gateway.request<CloudMein>("/v1/cloud/mein", { signal: c.signal });
      return serverLage(d);
    },
  });
  return [stand];
}
