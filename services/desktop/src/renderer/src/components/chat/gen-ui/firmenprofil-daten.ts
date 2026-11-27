// Generative UI: Daten fuer den Baustein „Firmenprofil“ (reine Funktionen, ohne React).
//
// Befund PM-2026-0059 (Joyce, 2026-11-27): Der Firmenueberblick im Chat war eine
// nackte Tabelle, obwohl LinkedIn-Profile, Adresse und Website vorlagen. Der Baustein
// laedt diese Angaben selbst aus der companyId (wie die Firmenansicht); hier steht,
// wie aus den Kontakt-Fakten die gezeigten Ansprechpartner und Firmen-Links werden.

import { rangFuerTitel } from "../../../routes/kontakt-rang";

export type Fakt = {
  entityType?: string;
  entityId?: string;
  /** Firma, bei der der Fakt beobachtet wurde (Rollenfakten gelten nur dort). */
  companyId?: string;
  field?: string;
  value?: string;
  status?: string;
};

export interface ProfilPerson {
  personId: string;
  name: string;
  titel: string | null;
  linkedin: string | null;
  xing: string | null;
  /** 3 Geschaeftsleitung, 2 Leitung, 1 Vertrieb/Einkauf, 0 uebrige. */
  rang: number;
}

/** Rollenfakten gehoeren zur Firma (wie nurRollenDieserFirma in der Firmenansicht). */
const ROLLENFELDER = new Set(["jobTitle", "department", "employmentSince", "seniority"]);

const https = (v: string | undefined | null): string | null => {
  const t = (v ?? "").trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^https?:\/\//i.test(t)) return null;
  const mit = (/^https?:\/\//i.test(t) ? t : `https://${t}`).replace(/^http:\/\//i, "https://");
  try {
    return new URL(mit).hostname.includes(".") ? mit : null;
  } catch {
    return null;
  }
};

/**
 * Personen mit Namen aus den Kontakt-Fakten einer Firma, nach Rang und Name.
 * Wer hier eine Position hatte, die nicht mehr gilt (kein aktiver Titel mehr),
 * faellt weg: Der Ueberblick soll niemanden nennen, der die Firma verlassen hat.
 */
export function personenAusFakten(fakten: Fakt[] | null | undefined, companyId: string): ProfilPerson[] {
  const jePerson = new Map<string, Fakt[]>();
  for (const f of fakten ?? []) {
    if (f.entityType !== "PERSON" || !f.entityId) continue;
    if (ROLLENFELDER.has(f.field ?? "") && f.companyId && f.companyId !== companyId) continue;
    const liste = jePerson.get(f.entityId);
    if (liste) liste.push(f);
    else jePerson.set(f.entityId, [f]);
  }
  const wert = (pf: Fakt[], feld: string) =>
    pf.find((f) => f.field === feld && f.status === "ACTIVE")?.value ?? pf.find((f) => f.field === feld)?.value;
  const out: ProfilPerson[] = [];
  for (const [personId, pf] of jePerson) {
    const name = wert(pf, "fullName")?.trim();
    if (!name) continue;
    const titelFakten = pf.filter((f) => f.field === "jobTitle");
    if (titelFakten.length > 0 && !titelFakten.some((f) => f.status === "ACTIVE")) continue;
    const titel = wert(pf, "jobTitle")?.trim() || null;
    out.push({ personId, name, titel, linkedin: https(wert(pf, "linkedinUrl")), xing: https(wert(pf, "xingUrl")), rang: rangFuerTitel(titel) });
  }
  return out.sort((a, b) => b.rang - a.rang || Number(Boolean(b.linkedin)) - Number(Boolean(a.linkedin)) || a.name.localeCompare(b.name, "de"));
}

/**
 * Welche Ansprechpartner der Ueberblick zeigt: die vom Modell genannten personIds in
 * dessen Reihenfolge (Unbekannte fallen weg), sonst die ranghoechsten.
 */
export function personenAuswahl(alle: ProfilPerson[], personIds: Array<string | null | undefined> | null | undefined, max = 4): ProfilPerson[] {
  const gewuenscht = (personIds ?? []).filter((x): x is string => typeof x === "string" && x.trim() !== "");
  if (gewuenscht.length > 0) {
    const nachId = new Map(alle.map((p) => [p.personId, p]));
    const treffer = [...new Set(gewuenscht)].flatMap((id) => (nachId.has(id) ? [nachId.get(id)!] : []));
    if (treffer.length > 0) return treffer.slice(0, max);
  }
  return alle.slice(0, max);
}

const SOCIAL_NAME: Record<string, string> = {
  linkedin: "LinkedIn",
  xing: "XING",
  instagram: "Instagram",
  facebook: "Facebook",
  twitter: "X",
  youtube: "YouTube",
  tiktok: "TikTok",
};

export interface FirmenLink {
  art: string;
  label: string;
  url: string;
}

/**
 * Profile der Firma in sozialen Netzen: von der Website, ergaenzt um die
 * LinkedIn-Firmenseite aus den Kontaktdaten. LinkedIn und XING zuerst.
 */
export function firmenLinks(socialLinks: Array<{ platform?: string; url?: string }> | null | undefined, fakten: Fakt[] | null | undefined): FirmenLink[] {
  const out: FirmenLink[] = [];
  const nimm = (art: string, roh: string | undefined | null) => {
    const url = https(roh);
    const a = art.toLowerCase();
    if (!url || out.some((l) => l.art === a)) return;
    out.push({ art: a, label: SOCIAL_NAME[a] ?? art, url });
  };
  for (const s of socialLinks ?? []) if (s.platform) nimm(s.platform, s.url);
  for (const f of fakten ?? []) {
    if (f.entityType !== "COMPANY" || f.status === "INACTIVE") continue;
    if (/^linkedin/i.test(f.field ?? "") && /linkedin\.com\/(company|school|showcase)\//i.test(f.value ?? "")) nimm("linkedin", f.value);
    if (/^xing/i.test(f.field ?? "") && /xing\.com\//i.test(f.value ?? "")) nimm("xing", f.value);
  }
  const vorne = (l: FirmenLink) => (l.art === "linkedin" ? 0 : l.art === "xing" ? 1 : 2);
  return out.sort((a, b) => vorne(a) - vorne(b));
}

/** Erster aktiver Firmen-Fakt eines Feldes (Telefon, allgemeine E-Mail). */
export function firmenFakt(fakten: Fakt[] | null | undefined, feld: string): string | null {
  const f = (fakten ?? []).find((x) => x.entityType === "COMPANY" && x.field === feld && x.status === "ACTIVE" && (x.value ?? "").trim());
  return f?.value?.trim() ?? null;
}

/**
 * Allgemeine E-Mail-Adresse der Firma: info@/kontakt@ vor Vertrieb, dann der Rest
 * (Echttest 2026-11-27: bei Nexburg stand sonst uk-support@ als „allgemeiner Kontakt“).
 */
export function firmenMail(fakten: Fakt[] | null | undefined): string | null {
  const alle = (fakten ?? [])
    .filter((x) => x.entityType === "COMPANY" && x.field === "email" && x.status === "ACTIVE" && /^[^@\s]+@[^@\s]+$/.test((x.value ?? "").trim()))
    .map((x) => x.value!.trim());
  const rang = (m: string) => {
    const lokal = m.split("@")[0]!.toLowerCase();
    if (/^(info|kontakt|contact|office|mail|hello|hallo|zentrale|post|welcome)$/.test(lokal)) return 0;
    if (/^(vertrieb|sales)$/.test(lokal)) return 1;
    return 2;
  };
  return alle.map((m, i) => ({ m, i })).sort((a, b) => rang(a.m) - rang(b.m) || a.i - b.i)[0]?.m ?? null;
}

/** „nexburg.com“ aus einer Website-Adresse, fuer die Anzeige. */
export function websiteAnzeige(url: string | null | undefined): string | null {
  const t = (url ?? "").trim();
  if (!t) return null;
  return t.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
}

/** Zwei Buchstaben fuer das Namenskuerzel im Kopf („Nexburg GmbH“ → „N“, „Müller Bau“ → „MB“). */
export function kuerzel(name: string | null | undefined): string {
  const worte = (name ?? "")
    .replace(/\b(gmbh|mbh|ag|kg|kgaa|ohg|gbr|ug|se|eg|ltd|limited|plc|inc|co)\b\.?/giu, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const k = worte.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return k || "?";
}
