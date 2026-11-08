// Funktionsadressen und Adressmuster — Spiegel von packages/email-muster/src/pattern.ts
// (FUNKTIONS_LOCALS, MUSTER-Ids). Das Gateway haengt nicht am Paket; bei Aenderungen
// dort beide Listen nachziehen. Anlass PM-2026-0010: info@ontras.com wurde als
// abgeleitete Personenadresse bei allen Personen der Firma gespeichert.

const FUNKTIONS_LOCALS = new Set([
  "info", "kontakt", "contact", "hello", "hallo", "office", "mail", "post", "hr", "ir", "pr", "presse", "press", "vertrieb", "sales", "support",
  "service", "kundenservice", "buchhaltung", "rechnung", "invoice", "bewerbung", "jobs", "karriere", "career", "careers", "marketing", "team",
  "admin", "webmaster", "postmaster", "noreply", "no-reply", "newsletter", "anfrage", "anfragen", "zentrale", "empfang", "verwaltung",
  "datenschutz", "privacy", "legal", "recht", "einkauf", "purchasing", "export", "import", "shop", "bestellung", "order", "orders", "welcome",
]);

const MUSTER_IDS = new Set([
  "vorname.nachname", "v.nachname", "vnachname", "vorname", "nachname", "vorname_nachname", "vornamenachname", "nachname.vorname",
  "v-nachname", "vorname-nachname", "nachname.v", "nachnamev", "nachname_vorname", "vn",
]);

export function istFunktionsadresse(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase().trim() ?? "";
  if (!local) return true;
  if (FUNKTIONS_LOCALS.has(local)) return true;
  return /^(info|kontakt|office|mail|service|support|vertrieb|sales|hr|presse|jobs|karriere)[-_.]/.test(local);
}

/** Katalog-Id oder Vorlage mit Namensbezug; "info" o. ae. ergibt fuer alle Personen dieselbe Adresse. */
export function musterGueltig(muster: string): boolean {
  return MUSTER_IDS.has(muster) || /\{(vorname|nachname)\}/i.test(muster);
}
