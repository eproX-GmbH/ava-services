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
// jede mit hoechstens 5 RCPT TO (smtp-verify.ts), alle im Tages-Deckel.

import { MUSTER, bildeAdresse, domainVon, erkenneMuster, nameVarianten, type MusterBeleg } from "./pattern";
import { firmenDomain } from "./domain";
import { beurteileMuster, bildeAdresseAllgemein, ordneFirmenadressen, type Urteil, type Zuordnung } from "./zuordnung";
import { pruefeAdressen, zufallsAdresse, type PruefDetails, type PruefErgebnis, type PruefOptionen } from "./smtp-verify";
import type { FirmenKontakte, PersonInfo } from "./kontakte";

export const DOMAIN_RECHECK_MS = 30 * 86_400_000;
export const CATCHALL_RECHECK_MS = 90 * 86_400_000;
/** Ab so vielen Personen ohne Adresse wird das Muster an einer zweiten Person gegengeprueft. */
export const STICHPROBE_AB = 5;
/** Hoechstens so viele SMTP-Verbindungen je Firma (Format-Rate + Gegenprobe). */
export const MAX_DURCHGAENGE = 2;
/** Schutz gegen sehr grosse Personenlisten: so viele Adressen je Lauf speichern. */
export const MAX_PERSONEN = 50;
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
  hinweis?: string;
}

export type SpeicherErgebnis = "gespeichert" | "vorhanden" | "abgewiesen";

export interface AbleitungDeps {
  /** Standard: pruefeAdressen (smtp-verify.ts). */
  pruefe?: (domain: string, adressen: string[], opts: PruefOptionen) => Promise<Map<string, PruefDetails>>;
  /** Port 25 aus diesem Netz erreichbar (letzter Stand)? */
  netzOk: () => boolean;
  /** Eine Verbindung scheiterte am Netz (Port 25 gesperrt). */
  netzGesperrt?: (grund: string) => void;
  budget: { frei: () => number; verbrauche: (n: number) => void };
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
}

export type DomainUrteil = "verifiziert" | "catchall" | "offen" | "widerspruch" | "kein_format";
export type MusterHerkunft = "beleg" | "judge" | "cache" | "smtp" | "annahme";

export interface AbleitungsErgebnis {
  status: "fertig" | "nichts_zu_tun" | "keine_domain";
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
    arten: { smtp: 0, catchall: 0, offen: 0, abgelehnt: 0 },
    zusammenfassung: "",
  };

  // ---- 1. Domain ------------------------------------------------------------
  const fd = await firmenDomain({ firmenname: k.name, websiteUrl: k.websiteUrl, firmenEmails: k.firmenEmails, personen: k.personen, urteil });
  if (!fd) return { ...ergebnis, status: "keine_domain", zusammenfassung: `${k.name}: keine Domain der Firma bekannt (weder Website noch Firmenadresse)` };
  const domain = fd.domain;
  ergebnis.domain = domain;
  const unversorgt = k.personen.filter((p) => p.emails.length === 0 && p.offeneEmails.length === 0 && nameVarianten(p.fullName).length > 0).slice(0, MAX_PERSONEN);
  if (unversorgt.length === 0) return { ...ergebnis, status: "nichts_zu_tun", zusammenfassung: `${k.name}: alle Personen haben bereits eine Adresse` };

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

  // ---- 4./5. Einmal je Domain pruefen ----------------------------------------
  const ohneZuordnung = repraesentanten(unversorgt.filter((p) => !zugeordnet.has(p.personId)));
  const geprueft = new Map<string, Geprueft>();
  let domainUrteil: DomainUrteil = "offen";
  let offenGrund = "Mail-Pruefung in diesem Netz nicht moeglich";
  let gesperrt = false;

  /** Eine SMTP-Verbindung; respektiert Deckel, Netz und Verbindungshoechstzahl. */
  const sitzung = async (adressen: string[], bisErsterTreffer: boolean): Promise<Map<string, PruefDetails> | null> => {
    if (ergebnis.smtpVerbindungen >= MAX_DURCHGAENGE || gesperrt || !deps.netzOk()) return null;
    const frei = deps.budget.frei();
    if (frei <= 0) {
      offenGrund = "Tages-Deckel fuer Mail-Pruefungen erreicht";
      return null;
    }
    const liste = adressen.slice(0, Math.min(5, frei));
    if (liste.length === 0) return null;
    ergebnis.smtpVerbindungen++;
    const r = await pruefe(domain, liste, { catchAllProbe: probe(domain), log: deps.log, bisErsterTreffer });
    const werte = [...r.values()];
    const anfragen = werte.some((w) => w.ergebnis === "catch_all") ? 1 : werte.filter((w) => w.mx !== null && w.ergebnis !== "gesperrt").length;
    ergebnis.smtpAnfragen += anfragen;
    deps.budget.verbrauche(anfragen);
    const sperre = werte.find((w) => w.ergebnis === "gesperrt");
    if (sperre) {
      gesperrt = true;
      offenGrund = "Mail-Pruefung in diesem Netz nicht moeglich";
      deps.netzGesperrt?.(sperre.antwort ?? "Verbindung zum Mailserver nicht moeglich");
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
      deps.log(`${a.email}: speichern fehlgeschlagen (${e instanceof Error ? e.message : String(e)})`);
      r = "abgewiesen";
    }
    if (r === "gespeichert") {
      ergebnis.gespeichert++;
      ergebnis.arten[a.art]++;
    } else if (r === "vorhanden") ergebnis.vorhanden++;
    else ergebnis.abgewiesen++;
  };

  // Zugeordnete Firmenadressen: echte Adressen von der Website.
  for (const z of zuordnungen) {
    const art: Art = domainUrteil === "catchall" ? "catchall" : "offen";
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
      hinweis: z.begruendung.slice(0, 300),
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
          ? `Muster der Domain per SMTP bestaetigt${baseline ? ` (${baseline})` : ""}, Adresse nicht einzeln geprueft`
          : domainUrteil === "widerspruch"
            ? "Mailserver lehnte eine Stichprobe nach diesem Muster ab"
            : offenGrund;
    }
    // Der Beleg muss an der Domain liegen; ohne echten Beleg zeigt er auf die erste abgeleitete Adresse.
    const beleg = baseline && domainVon(baseline) === domain ? baseline : email;
    await speichere({
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

  const a = ergebnis.arten;
  const teile = [
    a.smtp > 0 ? `${a.smtp} verifiziert` : "",
    a.catchall > 0 ? `${a.catchall} unbestaetigt (Catch-all)` : "",
    a.offen > 0 ? `${a.offen} abgeleitet` : "",
    a.abgelehnt > 0 ? `${a.abgelehnt} vom Server abgelehnt` : "",
    ergebnis.vorhanden > 0 ? `${ergebnis.vorhanden} schon vorhanden` : "",
    ergebnis.abgewiesen > 0 ? `${ergebnis.abgewiesen} nicht gespeichert` : "",
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
