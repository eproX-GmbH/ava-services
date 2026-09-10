// M1 (docs/PLAN_EMAIL_MUSTER.md) — Adressmuster einer Firma aus bekannten
// Personen-E-Mails ableiten und fuer weitere Personen anwenden. Electron-
// frei, ohne Netzverkehr; die Verifizierung steht in smtp-verify.ts.

export interface MusterBeleg {
  fullName: string;
  email: string;
}

export interface NameTeile {
  vorname: string;
  nachname: string;
  /** Alle Vornamen (bei "Anna Maria Meier": ["anna", "maria"]). */
  vornamen: string[];
  /** Nachname ohne Partikel ("von", "van", "de", "zu", "der"). */
  nachnameKurz: string;
}

export interface Muster {
  id: string;
  label: string;
  bilde: (n: NameTeile) => string | null;
}

/** Funktionsadressen — keine Personen, duerfen kein Muster liefern. */
const FUNKTIONS_LOCALS = new Set([
  "info", "kontakt", "contact", "hello", "hallo", "office", "mail", "post", "hr", "ir", "pr", "presse", "press", "vertrieb", "sales", "support",
  "service", "kundenservice", "buchhaltung", "rechnung", "invoice", "bewerbung", "jobs", "karriere", "career", "careers", "marketing", "team",
  "admin", "webmaster", "postmaster", "noreply", "no-reply", "newsletter", "anfrage", "anfragen", "zentrale", "empfang", "verwaltung",
  "datenschutz", "privacy", "legal", "recht", "einkauf", "purchasing", "export", "import", "shop", "bestellung", "order", "orders", "welcome",
]);

export function istFunktionsadresse(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase().trim() ?? "";
  if (!local) return true;
  if (FUNKTIONS_LOCALS.has(local)) return true;
  if (/^(info|kontakt|office|mail|service|support|vertrieb|sales|hr|presse|jobs|karriere)[-_.]/.test(local)) return true;
  return false;
}

/** Umlaute nach DIN 5008 (ae/oe/ue/ss) — Variante 1. */
export function umlauteAusschreiben(s: string): string {
  return s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue");
}

/** Diakritika entfernen (ä→a, é→e) — Variante 2. */
export function diakritikaEntfernen(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
}

const PARTIKEL = new Set(["von", "van", "de", "der", "den", "zu", "zum", "zur", "vom", "und", "y", "da", "di", "del", "della", "le", "la", "du", "des", "af", "ten", "ter"]);

function tokens(fullName: string): string[] {
  return fullName
    .replace(/[,;()"']/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !/^[A-Za-z]\.$/.test(t) && !/^(dr|prof|dipl|ing|mba|msc|bsc|ma|ba|mag)\.?$/i.test(t));
}

/**
 * Name in Vor-/Nachname zerlegen. Liefert je Schreibvariante (Umlaute
 * ausgeschrieben / Diakritika entfernt) eine Teilung; die Musterpruefung
 * probiert alle Varianten.
 */
export function nameVarianten(fullName: string): NameTeile[] {
  const out: NameTeile[] = [];
  for (const variante of [umlauteAusschreiben(fullName), diakritikaEntfernen(fullName)]) {
    const t = tokens(variante.toLowerCase());
    if (t.length < 2) continue;
    // Bindestrich-Doppelnamen: "anna-lena" bleibt als Vorname zusammen; im
    // Nachnamen "mueller-schmidt" gibt es die Varianten mit und ohne Bindestrich.
    const vornamen = t.slice(0, -1).filter((x) => !PARTIKEL.has(x));
    const nachnameRoh = t[t.length - 1]!;
    const partikel = t.slice(vornamen.length, -1).filter((x) => PARTIKEL.has(x));
    if (vornamen.length === 0) continue;
    const nachnameKurz = nachnameRoh.replace(/[^a-z0-9-]/g, "");
    const nachnameMitPartikel = (partikel.join("") + nachnameKurz).replace(/[^a-z0-9-]/g, "");
    const vorname = vornamen[0]!.replace(/[^a-z0-9-]/g, "");
    const basis = { vorname, vornamen: vornamen.map((v) => v.replace(/[^a-z0-9-]/g, "")), nachnameKurz };
    for (const nachname of new Set([nachnameKurz, nachnameMitPartikel, nachnameKurz.replace(/-/g, ""), nachnameMitPartikel.replace(/-/g, "")])) {
      if (!nachname) continue;
      out.push({ ...basis, nachname });
      if (vorname.includes("-")) out.push({ ...basis, vorname: vorname.replace(/-/g, ""), nachname });
    }
  }
  // Duplikate entfernen
  const seen = new Set<string>();
  return out.filter((n) => {
    const k = `${n.vorname}|${n.nachname}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const v = (n: NameTeile): string => n.vorname;
const nn = (n: NameTeile): string => n.nachname;
const vi = (n: NameTeile): string => n.vorname.charAt(0);
const ni = (n: NameTeile): string => n.nachname.charAt(0);

/** Musterkatalog, Reihenfolge nach Verbreitung im DACH-B2B. */
export const MUSTER: Muster[] = [
  { id: "vorname.nachname", label: "vorname.nachname", bilde: (n) => `${v(n)}.${nn(n)}` },
  { id: "v.nachname", label: "v.nachname", bilde: (n) => `${vi(n)}.${nn(n)}` },
  { id: "vnachname", label: "vnachname", bilde: (n) => `${vi(n)}${nn(n)}` },
  { id: "vorname", label: "vorname", bilde: (n) => v(n) },
  { id: "nachname", label: "nachname", bilde: (n) => nn(n) },
  { id: "vorname_nachname", label: "vorname_nachname", bilde: (n) => `${v(n)}_${nn(n)}` },
  { id: "vornamenachname", label: "vornamenachname", bilde: (n) => `${v(n)}${nn(n)}` },
  { id: "nachname.vorname", label: "nachname.vorname", bilde: (n) => `${nn(n)}.${v(n)}` },
  { id: "v-nachname", label: "v-nachname", bilde: (n) => `${vi(n)}-${nn(n)}` },
  { id: "vorname-nachname", label: "vorname-nachname", bilde: (n) => `${v(n)}-${nn(n)}` },
  { id: "nachname.v", label: "nachname.v", bilde: (n) => `${nn(n)}.${vi(n)}` },
  { id: "nachnamev", label: "nachnamev", bilde: (n) => `${nn(n)}${vi(n)}` },
  { id: "nachname_vorname", label: "nachname_vorname", bilde: (n) => `${nn(n)}_${v(n)}` },
  { id: "vn", label: "vn (Initialen)", bilde: (n) => `${vi(n)}${ni(n)}` },
];

export function domainVon(email: string): string {
  return (email.split("@")[1] ?? "").toLowerCase().trim();
}

/** Passt eine Adresse zu einem Muster (fuer irgendeine Namensvariante)? */
export function passtZuMuster(muster: Muster, fullName: string, email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase().trim() ?? "";
  if (!local) return false;
  for (const n of nameVarianten(fullName)) {
    const k = muster.bilde(n);
    if (k && k === local) return true;
  }
  return false;
}

export interface MusterBefund {
  domain: string;
  muster: string | null;
  konfidenz: number;
  /** Belege, die das Muster erklaeren. */
  belege: MusterBeleg[];
  /** Personen-Adressen, die zu keinem Muster passen (z. B. Spitznamen). */
  unerklaert: MusterBeleg[];
  /** Ausgeschlossene Funktionsadressen. */
  funktionsadressen: string[];
  /** Mehrere Muster moeglich (bei nur einem Beleg): Kandidaten in Reihenfolge. */
  alternativen: string[];
}

/**
 * Muster je Domain erkennen. Ein Muster gilt, wenn es ALLE personengebundenen
 * Belege der Domain erklaert. Bei einem einzigen Beleg passen oft mehrere
 * Muster (z. B. "anna@" = vorname UND vornamenachname bei Einwort-Namen);
 * dann gewinnt das verbreitetste, die anderen stehen unter `alternativen`.
 */
export function erkenneMuster(domain: string, belege: MusterBeleg[]): MusterBefund {
  const d = domain.toLowerCase().trim();
  const funktionsadressen: string[] = [];
  const personen: MusterBeleg[] = [];
  for (const b of belege) {
    if (domainVon(b.email) !== d) continue;
    if (istFunktionsadresse(b.email)) {
      funktionsadressen.push(b.email);
      continue;
    }
    if (nameVarianten(b.fullName).length === 0) continue;
    personen.push({ fullName: b.fullName, email: b.email.toLowerCase().trim() });
  }
  const leer: MusterBefund = { domain: d, muster: null, konfidenz: 0, belege: [], unerklaert: personen, funktionsadressen, alternativen: [] };
  if (personen.length === 0) return leer;
  // Je Muster: welche Belege erklaert es?
  const treffer = MUSTER.map((m) => ({ m, erklaert: personen.filter((b) => passtZuMuster(m, b.fullName, b.email)) }));
  const voll = treffer.filter((t) => t.erklaert.length === personen.length);
  if (voll.length === 0) {
    // Kein Muster erklaert alles: bestes Teil-Muster nur, wenn es mindestens 2 Belege
    // erklaert und die uebrigen hoechstens ein Drittel sind (Spitznamen/Altadressen).
    const best = treffer.sort((a, b) => b.erklaert.length - a.erklaert.length)[0]!;
    if (best.erklaert.length >= 2 && best.erklaert.length >= Math.ceil((personen.length * 2) / 3)) {
      const rest = personen.filter((p) => !best.erklaert.includes(p));
      return { domain: d, muster: best.m.id, konfidenz: 0.7, belege: best.erklaert, unerklaert: rest, funktionsadressen, alternativen: [] };
    }
    return leer;
  }
  const gewaehlt = voll[0]!;
  const n = gewaehlt.erklaert.length;
  const konfidenz = n >= 3 ? 0.95 : n === 2 ? 0.85 : 0.6;
  return {
    domain: d,
    muster: gewaehlt.m.id,
    konfidenz,
    belege: gewaehlt.erklaert,
    unerklaert: [],
    funktionsadressen,
    alternativen: voll.slice(1).map((t) => t.m.id),
  };
}

/** Adresse fuer eine Person nach Muster bilden (erste Namensvariante = Umlaute ausgeschrieben). */
export function bildeAdresse(musterId: string, fullName: string, domain: string): string | null {
  const m = MUSTER.find((x) => x.id === musterId);
  if (!m) return null;
  const varianten = nameVarianten(fullName);
  const n = varianten[0];
  if (!n) return null;
  const local = m.bilde(n);
  if (!local || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(local)) return null;
  return `${local}@${domain.toLowerCase().trim()}`;
}
