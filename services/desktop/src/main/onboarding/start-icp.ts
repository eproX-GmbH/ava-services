// Onboarding O2 (docs/PLAN_ONBOARDING.md): ICP aus der Start-Analyse EINMALIG
// in die App uebernehmen und den ersten Chat eroeffnen.
//
// Joyce 2026-11-08: Das passiert genau ein einziges Mal am Anfang. Ein ICP, den
// sich der Nutzer erarbeitet hat, darf nie wieder von der Start-Analyse
// ueberschrieben werden, auch nicht nach Ab- und Anmelden, Neuinstallation,
// Zuruecksetzen oder auf einem zweiten Rechner. Drei Sperren:
//   1. Server: /v1/onboarding/start/abholen liefert den Vorschlag atomar nur
//      beim allerersten Aufruf je Konto (danach immer "schon_abgeholt").
//   2. Lokal leer: abgeholt wird nur, wenn hier noch kein ICP existiert; sonst
//      wird der Vorschlag serverseitig verworfen (lokalLeer=false).
//   3. Lokale Marke `startIcpGeprueft` in onboarding.json: danach nie wieder.
// Kurz vor dem Speichern wird noch einmal geprueft, ob der ICP inzwischen
// gesetzt wurde (Nutzer war schneller): dann bleibt seiner stehen.

import { hostname, platform } from "node:os";
import { markeLesen, markeSetzen, type OnboardingMarke } from "./marke";
import type { GatewayClient } from "../agent/gateway-client";
import type { IcpProfile } from "../agent/icp-store";
import type { AgentKartenAktion } from "../../shared/types";

const TAKT_MS = 20_000;
/** Laeuft die Analyse beim Start noch, fragt die App so lange je Sitzung nach. */
const MAX_SITZUNG_MS = 45 * 60_000;

type Status = "offen" | "laeuft" | "fertig" | "freemail" | "keine_website" | "fehlgeschlagen";
interface Stand { status: Status; domain: string | null; website: string | null; abgeholt: boolean; firma: string | null }

interface Referenz { name: string; domain: string | null; ort: string; profil: { branche: string } | null }
interface Vorschlag {
  website: string;
  eigeneFirma: { name: string; ort: string; branche: string; kurzbeschreibung: string };
  icp: Pick<IcpProfile, "beschreibung" | "angebot" | "nutzen" | "branchen" | "orte" | "radiusKm" | "groesse" | "merkmale" | "ausschluesse" | "kundenBeispiele">;
  referenzen: Referenz[];
}

type AbholAntwort = { art: "vorschlag"; vorschlag: Vorschlag } | { art: "schon_abgeholt" } | { art: "verworfen" } | { art: "nicht_fertig"; status: Status | null };

export interface StartIcpDeps {
  gateway: GatewayClient;
  datei: string;
  icp: { isSet(): boolean; set(patch: Partial<IcpProfile>): IcpProfile };
  /** Gibt es schon Unterhaltungen? Dann ist es kein neues Konto (Altbestand ohne Auftrag). */
  hatVerlauf: () => boolean;
  begruessen: (text: string, aktionen: AgentKartenAktion[]) => string;
  aktiv: () => boolean;
  /** O3: neues Konto erkannt (ICP uebernommen oder Website erfragt) → Start-Workflow anlegen. */
  neuesKonto?: () => void;
}

export class StartIcpUebernahme {
  private timer: NodeJS.Timeout | null = null;
  private seit = 0;
  private laeuft = false;

  constructor(private readonly deps: StartIcpDeps) {}

  start(): void {
    if (this.timer || this.marke().startIcpGeprueft) return;
    this.seit = Date.now();
    this.timer = setInterval(() => void this.takt(), TAKT_MS);
    this.timer.unref?.();
    void this.takt();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private marke(): OnboardingMarke {
    return markeLesen(this.deps.datei);
  }

  private markeSetzen(patch: Partial<OnboardingMarke>): void {
    markeSetzen(this.deps.datei, patch);
  }

  private fertig(grund: string): void {
    this.markeSetzen({ startIcpGeprueft: new Date().toISOString() });
    console.info(`[onboarding] Start-ICP erledigt: ${grund}`);
    this.stop();
  }

  private instanz(): string {
    return `${platform()}:${hostname()}`.slice(0, 120);
  }

  private async takt(): Promise<void> {
    if (this.laeuft || !this.deps.aktiv()) return;
    if (this.marke().startIcpGeprueft) { this.stop(); return; }
    if (Date.now() - this.seit > MAX_SITZUNG_MS) { this.stop(); return; }
    this.laeuft = true;
    try {
      await this.pruefen();
    } catch (err) {
      // Gateway noch ohne Onboarding (404) oder offline: spaeter erneut, nichts markieren.
      console.warn("[onboarding] Start-ICP:", err instanceof Error ? err.message.slice(0, 160) : err);
    } finally {
      this.laeuft = false;
    }
  }

  private async pruefen(): Promise<void> {
    const { stand } = await this.deps.gateway.request<{ stand: Stand | null }>("/v1/onboarding/start");
    if (!stand) {
      // Altbestand (vor dem Onboarding registriert) oder schon gepflegter ICP: nichts tun.
      if (this.deps.hatVerlauf() || this.deps.icp.isSet()) { this.fertig("kein Auftrag, Konto schon in Benutzung"); return; }
      await this.deps.gateway.request("/v1/onboarding/start", { method: "POST", body: {} });
      return;
    }
    if (stand.abgeholt) { this.fertig("schon abgeholt"); return; }
    if (this.deps.icp.isSet()) {
      await this.deps.gateway.request("/v1/onboarding/start/abholen", { method: "POST", body: { instanz: this.instanz(), lokalLeer: false } });
      this.fertig("lokaler ICP vorhanden, Vorschlag verworfen");
      return;
    }
    if (stand.status === "offen" || stand.status === "laeuft") return;
    if (stand.status !== "fertig") {
      // Freemail, keine Website, fehlgeschlagen: einmal nach der Website fragen, dann warten.
      if (!this.marke().websiteGefragt) {
        const id = this.deps.begruessen(websiteFrage(stand), []);
        this.markeSetzen({ websiteGefragt: new Date().toISOString(), begruessungId: id });
        this.deps.neuesKonto?.();
      }
      return;
    }
    const a = await this.deps.gateway.request<AbholAntwort>("/v1/onboarding/start/abholen", { method: "POST", body: { instanz: this.instanz(), lokalLeer: true } });
    if (a.art !== "vorschlag") { this.fertig(`Abholung: ${a.art}`); return; }
    // Sperre 2 noch einmal direkt vor dem Schreiben.
    if (this.deps.icp.isSet()) { this.fertig("ICP in der Zwischenzeit gesetzt, Vorschlag nicht uebernommen"); return; }
    const v = a.vorschlag;
    this.deps.icp.set({ ...v.icp, quelle: "start-analyse" });
    this.fertig(`ICP aus ${v.website} uebernommen`);
    this.deps.neuesKonto?.();
    this.deps.begruessen(begruessungText(v), [
      { art: "chat_vorschlag", label: "Passt, such mir passende Firmen", auftrag: "Mein Idealkundenprofil passt. Starte den Firmen-Radar und zeig mir die besten Treffer." },
      { art: "app_oeffnen", label: "Profil anpassen", pfad: "/icp-assistent" },
    ]);
  }
}

function domainVon(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function begruessungText(v: Vorschlag): string {
  const zeilen: string[] = [];
  const firma = v.eigeneFirma.name ? `, die Website von **${v.eigeneFirma.name}**` : "";
  zeilen.push(`Willkommen bei AVA! 👋 Ich habe mir **${domainVon(v.website)}**${firma} schon angesehen.`);
  if (v.icp.angebot) zeilen.push(`**Was ihr anbietet:** ${v.icp.angebot}`);
  if (v.icp.beschreibung) zeilen.push(`**Deine idealen Kunden:** ${v.icp.beschreibung}`);
  const fakten: string[] = [];
  if (v.icp.branchen.length) fakten.push(`Branchen: ${v.icp.branchen.join(", ")}`);
  if (v.icp.orte.length) fakten.push(`Region: ${v.icp.orte.join(", ")} (${v.icp.radiusKm} km Umkreis)`);
  if (fakten.length) zeilen.push(fakten.join(" · "));
  const mitProfil = v.referenzen.filter((r) => r.profil);
  if (mitProfil.length) {
    const liste = mitProfil.map((r) => `${r.name}${r.profil?.branche ? ` (${r.profil.branche})` : ""}`).join(", ");
    zeilen.push(`Auf eurer Website habe ich Referenzkunden gefunden und mir angesehen: ${liste}. Firmen wie diese suche ich bevorzugt.`);
  }
  zeilen.push("Das habe ich als dein Idealkundenprofil angelegt. Schau kurz drüber: Passt es, suche ich dir direkt passende Firmen. Sonst passen wir es gemeinsam an.");
  return zeilen.join("\n\n");
}

function websiteFrage(stand: Stand): string {
  const grund =
    stand.status === "fehlgeschlagen" && stand.domain
      ? `Die Website zu **${stand.domain}** konnte ich gerade nicht lesen.`
      : stand.status === "keine_website" && stand.domain
        ? `Unter **${stand.domain}** habe ich keine Firmen-Website gefunden.`
        : "";
  return [
    "Willkommen bei AVA! 👋",
    `${grund ? `${grund} ` : ""}Damit ich dir gleich passende Firmen zeigen kann: Wie lautet die Website deiner Firma? Ich sehe sie mir an, finde eure Referenzkunden und lege daraus dein Idealkundenprofil an.`,
  ].join("\n\n");
}
