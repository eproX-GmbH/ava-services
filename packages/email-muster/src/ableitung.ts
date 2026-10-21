// hunter.io-artige Ableitung je Firma (docs/PLAN_EMAIL_VERIFIZIERUNG.md §3.1):
// Muster herleiten, EINMAL je Domain per SMTP bestaetigen und dann auf alle
// Personen derselben Domain anwenden — nicht jede Adresse einzeln pruefen.
//
//   1. Domain bestimmen (domain.ts). Ohne Domain keine Ableitung.
//   2. Belege: personengebundene Adressen der Domain + Firmenadressen, die
//      zuordnung.ts einer Person zuordnet.
//   3. Beleg vorhanden → Muster aus dem Katalog (pattern.ts), bei Unklarheit
//      KI-Urteil (beurteileMuster). Sonst ein frisches Muster vom Gateway.
//   4. Kein Muster → Formate fuer EINE Person durchprobieren
//      (vorname.nachname, vorname, v.nachname, nachname …), bis der Server
//      eine Adresse annimmt. Der Treffer ist das Muster der Domain.
//   5. Ein bekanntes Muster wird an einem Repraesentanten bestaetigt; ab
//      STICHPROBE_AB Personen kommt eine Stichprobe dazu. Lehnt der Server ab,
//      wird das Muster neu geraten statt blind angewandt.
//   6. Muster auf alle unversorgten Personen anwenden und speichern; Muster und
//      Catch-all-Befund teilen (PUT /v1/email-patterns/:domain).
//
// Netz, Gateway und KI kommen als Funktionen herein; die Datei bleibt ohne
// Seiteneffekte testbar. Hoechstens MAX_DURCHGAENGE SMTP-Verbindungen je Firma,
// jede mit hoechstens 5 RCPT TO (smtp-verify.ts); danach jede Adresse einzeln, ohne Tages-Deckel.

import { MUSTER, bildeAdresse, domainVon, erkenneMuster, nameVarianten, type MusterBeleg } from "./pattern";
import { firmenDomain } from "./domain";
import { beurteileMuster, bildeAdresseAllgemein, ordneFirmenadressen, type Urteil, type Zuordnung } from "./zuordnung";
import { pruefeAdressen, zufallsAdresse, type PruefDetails, type PruefErgebnis, type PruefOptionen } from "./smtp-verify";
import type { Takt } from "./takt";
import type { FirmenKontakte, PersonInfo } from "./kontakte";

export const DOMAIN_RECHECK_MS = 30 * 86_400_000;
/**
 * "Kein gaengiges Adressformat" nur 7 Tage glauben (Befund Zimmer Group
 * 2026-10-12: ein einziger geblockter Lauf sperrte die Ableitung fuer 99
 * Personen einen Monat lang; die Domain war in Wahrheit Catch-all).
 */
export const KEIN_FORMAT_RECHECK_MS = 7 * 86_400_000;
export const CATCHALL_RECHECK_MS = 90 * 86_400_000;
/** Ab so vielen Personen ohne Adresse wird das Muster an einer zweiten Person gegengeprueft. */
export const STICHPROBE_AB = 5;
/** Schutz gegen sehr grosse Personenlisten: so viele Adressen je Lauf speichern. */
export const MAX_PERSONEN = 50;
/** Adressen je SMTP-Verbindung (4 RCPT + Catch-all-Probe). */
export const JE_VERBINDUNG = 5;
/**
 * Hoechstens so viele SMTP-Verbindungen je Firma: Format-Rate + Gegenprobe
 * und danach die Einzelpruefung jeder abgeleiteten Adresse (seit 2026-10-12,
 * Vorgabe des Operators: jede Adresse wird verifiziert, kein Tages-Deckel).
 */
export const MAX_DURCHGAENGE = 4 + Math.ceil((MAX_PERSONEN * 2) / JE_VERBINDUNG);
/** Rate-Reihenfolge nach DACH-B2B-Verbreitung; je Durchgang eine Gruppe (4 RCPT + Catch-all-Probe = 5). */
export const RATE_GRUPPEN: string[][] = [
  ["vorname.nachname", "vorname", "v.nachname", "nachname"],
  ["vnachname", "vorname_nachname", "vornamenachname", "nachname.vorname"],
];
/** Ohne Beleg und ohne Pruefmoeglichkeit: das verbreitetste Format, klar als Annahme markiert. */
export const ANNAHME_MUSTER = "vorname.nachname";

export type Art = "smtp" | "catchall" | "offen" | "abgelehnt";

export interface ServerMuster {
  muster: string | null;
  konfidenz: number;
  belege?: MusterBeleg[];
  catchAllAt: string | null;
  checkedAt: string;
  stats?: Record<string, unknown>;
}

export interface MusterSpeichern {
  muster: string | null;
  konfidenz: number;
  belege: MusterBeleg[];
  catchAll?: boolean;
  stats?: Record<string, unknown>;
}

/** Body fuer POST /v1/companies/:id/contacts/derived-email. */
export interface AbgeleiteteAdresse {
  personId: string;
  email: string;
  muster: string;
  beleg: string;
  baseline: string;
  musterQuelle?: "katalog" | "judge";
  herkunft: "muster" | "zuordnung";
  art: Art;
  domainQuelle: "website" | "firmenmail" | "alias";
  belegAnzahl?: number;
  mx?: string | null;
  checkedAt: string;
  smtpCode?: number;
  /** Antwortzeile des Mailservers (Beleg fuer abgelehnt/verifiziert, max. 200 Zeichen). */
  smtpAntwort?: string;
  hinweis?: string;
  /** Reine Annahme ohne Pruefung (2026-10-21): die naechstverbreiteten Schreibweisen,
   *  damit die Karte nicht nur vorname.nachname zeigt (Befund eproX: jrafflenbeul). */
  alternativen?: string[];
}

export type SpeicherErgebnis = "gespeichert" | "vorhanden" | "abgewiesen";

export interface AbleitungDeps {
  /** Standard: pruefeAdressen (smtp-verify.ts). */
  pruefe?: (domain: string, adressen: string[], opts: PruefOptionen) => Promise<Map<string, PruefDetails>>;
  /** Port 25 aus diesem Netz erreichbar (letzter Stand)? */
  netzOk: () => boolean;
  /** Eine Verbindung scheiterte am Netz (Port 25 gesperrt). */
  netzGesperrt?: (grund: string) => void;
  /** Frische Gegenprobe gegen bekannte Mailserver: true = Port 25 geht noch, der
   *  Fehler lag am Mailserver der Domain, nicht am Netz. Ohne diese Funktion gilt
   *  jeder Verbindungsfehler als Netzsperre. */
  netzPruefe?: () => Promise<boolean>;
  /** Verifizierungsrate (takt.ts): wartet vor jeder Verbindung, bis die Anfragen erlaubt sind. Ohne: ungebremst. */
  takt?: Takt;
  urteil?: Urteil | null;
  holeMuster: (domain: string) => Promise<ServerMuster | null>;
  speichereMuster: (domain: string, body: MusterSpeichern) => Promise<void>;
  speichereAdresse: (a: AbgeleiteteAdresse) => Promise<SpeicherErgebnis>;
  log: (m: string) => void;
  jetzt?: () => Date;
  /** Zufallsadresse fuer die Catch-all-Probe (Tests setzen sie fest). */
  probe?: (domain: string) => string;
  /** Einstellung "Firmenadressen Personen zuordnen" (Standard an). */
  zuordnungAktiv?: boolean;
  /** Einstellung "unverifizierte Adressen anzeigen": false = nur smtp/catchall speichern (Standard an). */
  ungeprueftSpeichern?: boolean;
  /** Je gespeicherter/abgewiesener Adresse (Verlauf im Hintergrund-Job). */
  protokoll?: (eintrag: ProtokollEintrag) => void;
}

export interface ProtokollEintrag {
  adresse: AbgeleiteteAdresse;
  ergebnis: SpeicherErgebnis | "fehler";
  fehler?: string;
  smtp?: PruefErgebnis;
}

export type DomainUrteil = "verifiziert" | "catchall" | "offen" | "widerspruch" | "kein_format";
export type MusterHerkunft = "beleg" | "judge" | "cache" | "smtp" | "annahme";

export interface AbleitungsErgebnis {
  /** fehler: keine einzige Adresse liess sich speichern (Gateway nicht erreichbar o. ae.). */
  status: "fertig" | "nichts_zu_tun" | "keine_domain" | "fehler";
  domain: string | null;
  muster: string | null;
  musterHerkunft: MusterHerkunft | null;
  urteil: DomainUrteil | null;
  baseline: string | null;
  smtpVerbindungen: number;
  smtpAnfragen: number;
  gespeichert: number;
  vorhanden: number;
  abgewiesen: number;
  /** Speichern technisch gescheitert (Ausnahme), im Unterschied zu "abgewiesen" (Gateway lehnt ab). */
  speicherFehler: number;
  letzterFehler: string | null;
  arten: Record<Art, number>;
  zusammenfassung: string;
}

interface Geprueft {
  personId: string;
  email: string;
  details: PruefDetails;
}

function alterMs(iso: string | null | undefined, jetzt: Date): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? jetzt.getTime() - t : Infinity;
}

/** Personen mit zweiteiligem Namen zuerst — dort sind die Formate am eindeutigsten. */
function repraesentanten(personen: PersonInfo[]): PersonInfo[] {
  const teile = (p: PersonInfo) => p.fullName.trim().split(/\s+/).length;
  return [...personen].sort((a, b) => (teile(a) === 2 ? 0 : 1) - (teile(b) === 2 ? 0 : 1));
}

function artAus(e: PruefErgebnis): Art {
  return e === "existiert" ? "smtp" : e === "catch_all" ? "catchall" : e === "existiert_nicht" ? "abgelehnt" : "offen";
}

/** Ohne Beleg und ohne Pruefung: die naechstverbreiteten Formate nach vorname.nachname. */
export function alternativeAdressen(fullName: string, domain: string, ausser: string, max = 2): string[] {
  const out: string[] = [];
  for (const id of ["vnachname", "v.nachname", "vorname", "nachname"]) {
    const a = bildeAdresse(id, fullName, domain);
    if (a && a !== ausser && !out.includes(a)) out.push(a);
    if (out.length >= max) break;
  }
  return out;
}

export async function ermittleFirmenAdressen(companyId: string, k: FirmenKontakte, deps: AbleitungDeps): Promise<AbleitungsErgebnis> {
  const jetzt = deps.jetzt?.() ?? new Date();
  const pruefe = deps.pruefe ?? pruefeAdressen;
  const probe = deps.probe ?? zufallsAdresse;
  const urteil = deps.urteil ?? null;
  const ergebnis: AbleitungsErgebnis = {
    status: "fertig",
    domain: null,
    muster: null,
    musterHerkunft: null,
    urteil: null,
    baseline: null,
    smtpVerbindungen: 0,
    smtpAnfragen: 0,
    gespeichert: 0,
    vorhanden: 0,
    abgewiesen: 0,
    speicherFehler: 0,
    letzterFehler: null,
    arten: { smtp: 0, catchall: 0, offen: 0, abgelehnt: 0 },
    zusammenfassung: "",
  };

  // ---- 1. Domain ------------------------------------------------------------
  const fd = await firmenDomain({ firmenname: k.name, websiteUrl: k.websiteUrl, firmenEmails: k.firmenEmails, personen: k.personen, urteil });
  if (!fd) return { ...ergebnis, status: "keine_domain", zusammenfassung: `${k.name}: keine Domain der Firma bekannt (weder Website noch Firmenadresse)` };
  const domain = fd.domain;
  ergebnis.domain = domain;
  const unversorgt = k.personen.filter((p) => p.emails.length === 0 && p.offeneEmails.length === 0 && nameVarianten(p.fullName).length > 0).slice(0, MAX_PERSONEN);
  // Personen mit nur offener (unverifizierter) Ableitung: im selben Lauf einzeln
  // nachpruefen, damit sie nicht auf den Hintergrund-Job warten muessen.
  const nachpruefbar = deps.netzOk()
    ? k.personen
        .filter((p) => p.emails.length === 0 && p.offeneEmails.some((e) => domainVon(e) === domain))
        .map((p) => ({ p, email: p.offeneEmails.find((e) => domainVon(e) === domain)! }))
        .slice(0, MAX_PERSONEN)
    : [];
  if (unversorgt.length === 0 && nachpruefbar.length === 0) return { ...ergebnis, status: "nichts_zu_tun", zusammenfassung: `${k.name}: alle Personen haben bereits eine Adresse` };

  // ---- 2. Belege + Zuordnung von Firmenadressen ------------------------------
  const kandidatenAdressen = k.firmenEmails.filter((e) => domainVon(e) === domain);
  const zuordnungen: Zuordnung[] = deps.zuordnungAktiv !== false && kandidatenAdressen.length > 0 ? (await ordneFirmenadressen({ firmenEmails: kandidatenAdressen, personen: unversorgt, firmenname: k.name, urteil })).zuordnungen : [];
  const zugeordnet = new Set(zuordnungen.map((z) => z.personId));
  const belege: MusterBeleg[] = [
    ...k.personen.flatMap((p) => p.emails.filter((e) => domainVon(e) === domain).map((email) => ({ fullName: p.fullName, email }))),
    ...zuordnungen.map((z) => ({ fullName: z.fullName, email: z.email })),
  ];

  // ---- 3. Muster: Belege → KI-Urteil → Gateway --------------------------------
  const befund = erkenneMuster(domain, belege);
  let muster: string | null = befund.muster;
  let herkunft: MusterHerkunft | null = muster ? "beleg" : null;
  let baseline: string | null = befund.belege[0]?.email ?? null;
  let musterKonfidenz = befund.konfidenz;
  if (urteil && belege.length > 0 && (!muster || (befund.belege.length <= 1 && befund.alternativen.length > 1))) {
    const u = await beurteileMuster({ domain, belege, alternativen: befund.alternativen, urteil });
    if (u) {
      muster = u.muster;
      herkunft = "judge";
      baseline = u.baseline;
      musterKonfidenz = Math.max(0.5, befund.konfidenz);
      deps.log(`${k.name} (${domain}): Muster per KI-Urteil ${u.muster} (${u.begruendung})`);
    }
  }
  let server: ServerMuster | null = null;
  try {
    server = await deps.holeMuster(domain);
  } catch (e) {
    deps.log(`${domain}: Muster vom Gateway nicht lesbar (${e instanceof Error ? e.message : String(e)})`);
  }
  const serverFrisch = !!server && alterMs(server.checkedAt, jetzt) < DOMAIN_RECHECK_MS;
  const catchAllBekannt = !!server?.catchAllAt && alterMs(server.catchAllAt, jetzt) < CATCHALL_RECHECK_MS;
  // Auch ein abgelaufenes Muster ist ein guter Kandidat; es wird dann neu bestaetigt statt uebernommen.
  if (!muster && server?.muster) {
    muster = server.muster;
    herkunft = "cache";
    baseline = server.belege?.[0]?.email ?? (typeof server.stats?.baseline === "string" ? server.stats.baseline : null);
    musterKonfidenz = server.konfidenz;
  }
  const serverBestaetigt = serverFrisch && server?.stats?.verifiziert === true && !!muster && server.muster === muster;
  // Frischer Befund "kein Format bestaetigt": nicht bei jedem Contact-Lauf erneut raten.
  if (!muster && server?.stats?.keinFormat === true && alterMs(server.checkedAt, jetzt) < KEIN_FORMAT_RECHECK_MS) {
    return { ...ergebnis, urteil: "kein_format", zusammenfassung: `${k.name} (${domain}): Mailserver bestaetigte zuletzt kein gaengiges Adressformat — nichts abgeleitet` };
  }

  // ---- 4./5. Einmal je Domain pruefen ----------------------------------------
  const ohneZuordnung = repraesentanten(unversorgt.filter((p) => !zugeordnet.has(p.personId)));
  const geprueft = new Map<string, Geprueft>();
  let domainUrteil: DomainUrteil = "offen";
  let offenGrund = "Mail-Pruefung in diesem Netz nicht moeglich";
  let gesperrt = false;

  /** Eine SMTP-Verbindung; respektiert Netz und Verbindungshoechstzahl. Kein Tages-Deckel mehr (2026-10-12). */
  const sitzung = async (adressen: string[], bisErsterTreffer: boolean): Promise<Map<string, PruefDetails> | null> => {
    if (ergebnis.smtpVerbindungen >= MAX_DURCHGAENGE || gesperrt || !deps.netzOk()) return null;
    const liste = adressen.slice(0, JE_VERBINDUNG);
    if (liste.length === 0) return null;
    // Eine Verbindung = die Adressen plus die Catch-all-Probe.
    if (deps.takt) await deps.takt.warten(liste.length + 1);
    ergebnis.smtpVerbindungen++;
    const r = await pruefe(domain, liste, { catchAllProbe: probe(domain), log: deps.log, bisErsterTreffer });
    const werte = [...r.values()];
    const anfragen = werte.some((w) => w.ergebnis === "catch_all") ? 1 : werte.filter((w) => w.mx !== null && w.ergebnis !== "gesperrt").length;
    ergebnis.smtpAnfragen += anfragen;
    const sperre = werte.find((w) => w.ergebnis === "gesperrt");
    if (sperre && sperre.code != null) {
      // Der Server hat geantwortet, aber mit einer Richtlinie gegen den pruefenden
      // Host (5.7.x, "blocked", …) statt einer Auskunft zur Adresse. Keine weitere
      // Verbindung zu dieser Domain; Netz ist in Ordnung.
      gesperrt = true;
      offenGrund = `Mailserver lehnt Pruefanfragen ab (${(sperre.antwort ?? "Richtlinie").slice(0, 80)})`;
      deps.log(`${domain}: Richtliniensperre des Mailservers, Adressen bleiben offen (${sperre.antwort ?? "?"})`);
    } else if (sperre) {
      // Keine weitere Verbindung zu dieser Domain. Ob das Netz oder nur dieser
      // Mailserver schuld ist, klaert eine frische Gegenprobe — sonst sperrt ein
      // einzelner kaputter MX die Pruefung fuer alle Firmen.
      gesperrt = true;
      const netzNochOk = deps.netzPruefe ? await deps.netzPruefe().catch(() => false) : false;
      if (netzNochOk) {
        offenGrund = "Mailserver der Domain nicht erreichbar";
        deps.log(`${domain}: Mailserver nicht erreichbar (${sperre.antwort ?? "?"}), Port 25 sonst offen`);
      } else {
        offenGrund = "Mail-Pruefung in diesem Netz nicht moeglich";
        deps.netzGesperrt?.(sperre.antwort ?? "Verbindung zum Mailserver nicht moeglich");
      }
    } else if (werte.some((w) => w.ergebnis === "keine_mx")) {
      gesperrt = true;
      offenGrund = "Domain hat keinen Mailserver (kein MX-Eintrag)";
    } else if (werte.some((w) => w.ergebnis === "unbekannt")) {
      offenGrund = "Mailserver ohne eindeutige Antwort";
    }
    return r;
  };

  /** Formate fuer eine Person durchprobieren; liefert das Muster des ersten Treffers. */
  const rate = async (person: PersonInfo, ausser: Set<string>): Promise<"catch_all" | "kein_format" | "unklar" | { muster: string; adresse: string }> => {
    let alleAbgelehnt = true;
    for (const gruppe of RATE_GRUPPEN) {
      const kandidaten = new Map<string, string>();
      for (const id of gruppe) {
        if (ausser.has(id)) continue;
        const a = bildeAdresse(id, person.fullName, domain);
        if (a && !kandidaten.has(a) && !geprueft.has(`${person.personId}:${a}`)) kandidaten.set(a, id);
      }
      if (kandidaten.size === 0) continue;
      const r = await sitzung([...kandidaten.keys()], true);
      if (!r) return "unklar";
      for (const [adresse, d] of r) geprueft.set(`${person.personId}:${adresse}`, { personId: person.personId, email: adresse, details: d });
      if ([...r.values()].some((d) => d.ergebnis === "catch_all")) return "catch_all";
      const treffer = [...r.entries()].find(([, d]) => d.ergebnis === "existiert");
      if (treffer) return { muster: kandidaten.get(treffer[0])!, adresse: treffer[0] };
      if (![...r.values()].every((d) => d.ergebnis === "existiert_nicht")) alleAbgelehnt = false;
      if (!alleAbgelehnt) return "unklar";
    }
    return alleAbgelehnt ? "kein_format" : "unklar";
  };

  const darfPruefen = deps.netzOk() && !catchAllBekannt;
  if (catchAllBekannt) domainUrteil = "catchall";
  else if (serverBestaetigt) domainUrteil = "verifiziert";
  else if (!deps.netzOk()) offenGrund = "Mail-Pruefung in diesem Netz nicht moeglich";

  if (darfPruefen && !serverBestaetigt && ohneZuordnung.length > 0) {
    if (muster) {
      // Bekanntes Muster an einem Repraesentanten (plus Stichprobe) bestaetigen.
      const reps = ohneZuordnung.slice(0, ohneZuordnung.length >= STICHPROBE_AB ? 2 : 1);
      const adressen = reps.map((p) => ({ p, a: bildeAdresseAllgemein(muster!, p.fullName, domain) })).filter((x): x is { p: PersonInfo; a: string } => !!x.a);
      const r = adressen.length > 0 ? await sitzung(adressen.map((x) => x.a), false) : null;
      if (r) {
        for (const { p, a } of adressen) {
          const d = r.get(a);
          if (d) geprueft.set(`${p.personId}:${a}`, { personId: p.personId, email: a, details: d });
        }
        const werte = [...r.values()];
        if (werte.some((d) => d.ergebnis === "catch_all")) domainUrteil = "catchall";
        else if (werte.some((d) => d.ergebnis === "existiert_nicht")) {
          // Stichprobe widerspricht dem Muster: neu raten statt blind anwenden.
          const abgelehnt = adressen.find(({ a }) => r.get(a)?.ergebnis === "existiert_nicht")!;
          const katalog = MUSTER.some((m) => m.id === muster) ? new Set([muster]) : new Set<string>();
          const neu = await rate(abgelehnt.p, katalog);
          if (typeof neu === "object") {
            deps.log(`${k.name} (${domain}): Muster ${muster} widerlegt (${abgelehnt.a}), per SMTP ${neu.muster} bestaetigt`);
            muster = neu.muster;
            herkunft = "smtp";
            baseline = neu.adresse;
            musterKonfidenz = 0.8;
            domainUrteil = "verifiziert";
          } else if (neu === "catch_all") domainUrteil = "catchall";
          else domainUrteil = "widerspruch";
        } else if (werte.some((d) => d.ergebnis === "existiert")) {
          domainUrteil = "verifiziert";
          baseline = baseline ?? adressen.find(({ a }) => r.get(a)?.ergebnis === "existiert")?.a ?? null;
        }
      }
    } else {
      // Kein Beleg, kein Muster: Formate an einer Person durchprobieren.
      const rep = ohneZuordnung[0]!;
      const neu = await rate(rep, new Set());
      if (typeof neu === "object") {
        muster = neu.muster;
        herkunft = "smtp";
        baseline = neu.adresse;
        musterKonfidenz = 0.8;
        domainUrteil = "verifiziert";
        deps.log(`${k.name} (${domain}): kein Beleg, Format per SMTP bestaetigt: ${neu.muster} (${neu.adresse})`);
      } else if (neu === "catch_all") domainUrteil = "catchall";
      else if (neu === "kein_format") domainUrteil = "kein_format";
    }
  }

  // Ohne Muster bleibt nur die Annahme des verbreitetsten Formats — ausser alle Formate wurden abgelehnt.
  if (!muster && ohneZuordnung.length === 0 && zuordnungen.length === 0) {
    // Nur Nachpruefungen offener Adressen: dafuer braucht es kein Muster.
    muster = server?.muster ?? "nachpruefung";
    herkunft = "cache";
  }
  if (!muster) {
    if (domainUrteil === "kein_format") {
      ergebnis.urteil = domainUrteil;
      ergebnis.zusammenfassung = `${k.name} (${domain}): kein gaengiges Adressformat vom Mailserver bestaetigt — nichts abgeleitet`;
      await teileMuster(deps, domain, { muster: null, konfidenz: 0, belege: [], stats: { quelle: "live", firma: companyId, keinFormat: true } });
      return ergebnis;
    }
    muster = ANNAHME_MUSTER;
    herkunft = "annahme";
  }
  ergebnis.muster = muster;
  ergebnis.musterHerkunft = herkunft;

  // ---- 5b. Einzelpruefung jeder Adresse ---------------------------------------
  // Vorgabe des Operators (2026-10-12): abgeleitete Adressen werden nicht nur
  // ueber das Muster der Domain gestuetzt, sondern einzeln per RCPT TO geprueft;
  // dasselbe gilt fuer zugeordnete Firmenadressen und fuer bisher offene
  // Ableitungen. Nur Catch-all-Domains (jede Adresse wird angenommen) und
  // Domains ohne gaengiges Format bleiben aussen vor.
  const einzelnPruefen = deps.netzOk() && !gesperrt && domainUrteil !== "catchall" && domainUrteil !== "kein_format";
  if (einzelnPruefen) {
    const kandidaten: Array<{ personId: string; email: string }> = [];
    for (const p of ohneZuordnung) {
      const email = bildeAdresseAllgemein(muster, p.fullName, domain);
      if (email) kandidaten.push({ personId: p.personId, email });
    }
    for (const z of zuordnungen) kandidaten.push({ personId: z.personId, email: z.email });
    for (const n of nachpruefbar) kandidaten.push({ personId: n.p.personId, email: n.email });
    const offen = kandidaten.filter((c) => !geprueft.has(`${c.personId}:${c.email}`));
    for (let i = 0; i < offen.length; i += JE_VERBINDUNG) {
      const block = offen.slice(i, i + JE_VERBINDUNG);
      const r = await sitzung(block.map((c) => c.email), false);
      if (!r) break;
      for (const c of block) {
        const d = r.get(c.email);
        if (d) geprueft.set(`${c.personId}:${c.email}`, { personId: c.personId, email: c.email, details: d });
      }
      if ([...r.values()].some((d) => d.ergebnis === "catch_all")) {
        domainUrteil = "catchall";
        break;
      }
      if (domainUrteil !== "verifiziert" && [...r.values()].some((d) => d.ergebnis === "existiert")) domainUrteil = "verifiziert";
    }
  }
  ergebnis.urteil = domainUrteil;

  // ---- 6. Anwenden + speichern ------------------------------------------------
  const checkedAt = jetzt.toISOString();
  const musterQuelle: "katalog" | "judge" = herkunft === "judge" ? "judge" : "katalog";
  const belegAnzahl = belege.length;
  const annahme = herkunft === "annahme";
  const geprueftFuer = (personId: string, email: string) => geprueft.get(`${personId}:${email}`)?.details;
  const speichere = async (a: AbgeleiteteAdresse): Promise<void> => {
    // Wie der Hintergrund-Job: smtp/catchall immer, offen/abgelehnt nur mit Freigabe.
    if (deps.ungeprueftSpeichern === false && (a.art === "offen" || a.art === "abgelehnt")) return;
    let r: SpeicherErgebnis;
    try {
      r = await deps.speichereAdresse(a);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.log(`${a.email}: speichern fehlgeschlagen (${msg})`);
      ergebnis.speicherFehler++;
      ergebnis.letzterFehler = msg;
      deps.protokoll?.({ adresse: a, ergebnis: "fehler", fehler: msg, smtp: geprueftFuer(a.personId, a.email)?.ergebnis });
      return;
    }
    if (r === "gespeichert") {
      ergebnis.gespeichert++;
      ergebnis.arten[a.art]++;
    } else if (r === "vorhanden") ergebnis.vorhanden++;
    else ergebnis.abgewiesen++;
    deps.protokoll?.({ adresse: a, ergebnis: r, smtp: geprueftFuer(a.personId, a.email)?.ergebnis });
  };

  // Zugeordnete Firmenadressen: echte Adressen von der Website.
  for (const z of zuordnungen) {
    const dz = geprueftFuer(z.personId, z.email);
    const art: Art = dz ? artAus(dz.ergebnis) : domainUrteil === "catchall" ? "catchall" : "offen";
    await speichere({
      personId: z.personId,
      email: z.email,
      muster: "zuordnung",
      beleg: z.email,
      baseline: z.email,
      herkunft: "zuordnung",
      art,
      domainQuelle: fd.quelle,
      checkedAt,
      mx: dz?.mx ?? null,
      ...(dz?.code != null ? { smtpCode: dz.code } : {}),
      ...(dz?.antwort ? { smtpAntwort: dz.antwort.slice(0, 200) } : {}),
      hinweis: z.begruendung.slice(0, 300),
    });
  }

  // Bisher offene Ableitungen: nur ein neues Urteil wird gespeichert (offen bleibt offen).
  for (const n of nachpruefbar) {
    const d = geprueftFuer(n.p.personId, n.email);
    if (!d) continue;
    const art = annahme && d.ergebnis === "catch_all" ? "offen" : artAus(d.ergebnis);
    if (art === "offen") continue;
    await speichere({
      personId: n.p.personId,
      email: n.email,
      muster,
      beleg: n.email,
      baseline: n.email,
      musterQuelle,
      herkunft: "muster",
      art,
      domainQuelle: fd.quelle,
      mx: d.mx ?? null,
      checkedAt,
      ...(d.code != null ? { smtpCode: d.code } : {}),
      ...(d.antwort ? { smtpAntwort: d.antwort.slice(0, 200) } : {}),
    });
  }

  for (const p of ohneZuordnung) {
    const email = bildeAdresseAllgemein(muster, p.fullName, domain);
    if (!email) continue;
    const d = geprueftFuer(p.personId, email);
    let art: Art;
    let hinweis: string | undefined;
    // Bei einer Annahme belegt ein Catch-all-"250" das Format nicht.
    if (d && !(annahme && d.ergebnis === "catch_all")) art = artAus(d.ergebnis);
    else if (domainUrteil === "catchall") art = annahme ? "offen" : "catchall";
    else art = "offen";
    if (art === "offen") {
      hinweis = annahme
        ? domainUrteil === "catchall"
          ? "Catch-all-Domain ohne Beleg: verbreitetstes Format angenommen"
          : `kein Beleg, verbreitetstes Format angenommen; ${offenGrund}`
        : domainUrteil === "verifiziert"
          ? `Muster der Domain per SMTP bestaetigt${baseline ? ` (${baseline})` : ""}; Einzelpruefung: ${offenGrund}`
          : domainUrteil === "widerspruch"
            ? "Mailserver lehnte eine Stichprobe nach diesem Muster ab"
            : offenGrund;
    }
    // Der Beleg muss an der Domain liegen; ohne echten Beleg zeigt er auf die erste abgeleitete Adresse.
    const beleg = baseline && domainVon(baseline) === domain ? baseline : email;
    const alternativen = annahme && art === "offen" ? alternativeAdressen(p.fullName, domain, email) : [];
    await speichere({
      ...(alternativen.length > 0 ? { alternativen } : {}),
      personId: p.personId,
      email,
      muster,
      beleg,
      baseline: beleg,
      musterQuelle,
      herkunft: "muster",
      art,
      domainQuelle: fd.quelle,
      belegAnzahl,
      mx: d?.mx ?? null,
      checkedAt,
      ...(d?.code != null ? { smtpCode: d.code } : {}),
      ...(d?.antwort ? { smtpAntwort: d.antwort.slice(0, 200) } : {}),
      ...(hinweis ? { hinweis: hinweis.slice(0, 300) } : {}),
    });
  }
  ergebnis.baseline = baseline;

  // ---- Teilen: Muster + Catch-all (nie eine reine Annahme) --------------------
  if (!annahme) {
    const neuBestaetigt = domainUrteil === "verifiziert" && !serverBestaetigt;
    const neuesMuster = muster !== server?.muster || musterKonfidenz > (server?.konfidenz ?? 0);
    const catchAllNeu = domainUrteil === "catchall" && !catchAllBekannt;
    if (neuBestaetigt || catchAllNeu || (herkunft !== "cache" && neuesMuster)) {
      await teileMuster(deps, domain, {
        muster,
        konfidenz: Math.min(1, Math.max(0, neuBestaetigt ? Math.max(musterKonfidenz, 0.8) : musterKonfidenz)),
        belege: belege.slice(0, 20),
        ...(domainUrteil === "catchall" ? { catchAll: true } : {}),
        stats: { quelle: "live", firma: companyId, herkunft, verifiziert: domainUrteil === "verifiziert", ...(baseline ? { baseline } : {}) },
      });
    }
  } else if (domainUrteil === "catchall" && !catchAllBekannt) {
    await teileMuster(deps, domain, { muster: null, konfidenz: 0, belege: [], catchAll: true, stats: { quelle: "live", firma: companyId } });
  }

  if (ergebnis.gespeichert === 0 && ergebnis.vorhanden === 0 && ergebnis.speicherFehler > 0) {
    ergebnis.status = "fehler";
    ergebnis.zusammenfassung = `${k.name} (${domain}): ${ergebnis.speicherFehler} Adresse(n) konnten nicht gespeichert werden — ${ergebnis.letzterFehler}`;
    return ergebnis;
  }
  const a = ergebnis.arten;
  const teile = [
    a.smtp > 0 ? `${a.smtp} verifiziert` : "",
    a.catchall > 0 ? `${a.catchall} unbestaetigt (Catch-all)` : "",
    a.offen > 0 ? `${a.offen} abgeleitet` : "",
    a.abgelehnt > 0 ? `${a.abgelehnt} vom Server abgelehnt` : "",
    ergebnis.vorhanden > 0 ? `${ergebnis.vorhanden} schon vorhanden` : "",
    ergebnis.abgewiesen > 0 ? `${ergebnis.abgewiesen} vom Gateway abgewiesen` : "",
    ergebnis.speicherFehler > 0 ? `${ergebnis.speicherFehler} nicht gespeichert (${ergebnis.letzterFehler})` : "",
  ].filter(Boolean);
  ergebnis.zusammenfassung = `${k.name} (${domain}): ${teile.join(", ") || "nichts gespeichert"} — Muster ${muster} (${herkunft}), Domain ${domainUrteil}, ${ergebnis.smtpVerbindungen} SMTP-Verbindung(en)/${ergebnis.smtpAnfragen} Anfragen`;
  return ergebnis;
}

async function teileMuster(deps: AbleitungDeps, domain: string, body: MusterSpeichern): Promise<void> {
  try {
    await deps.speichereMuster(domain, body);
  } catch (e) {
    deps.log(`${domain}: Muster nicht geteilt (${e instanceof Error ? e.message : String(e)})`);
  }
}
