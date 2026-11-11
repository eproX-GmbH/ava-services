// PM-2026-0046 (Patrick): Leads und Radar-Kandidaten bekamen Domains, die keine
// Firmen-Website sind (tum.de fuer einen Freiberufler, bund.de, linktr.ee). Das
// Mini-Profil scheiterte daran jedes Mal oder beschrieb die falsche Organisation.
// Diese Domains taugen nie als Firmen-ID; sie werden bei der Zuordnung verworfen
// und im Profil-Worker mit Grund uebersprungen.

const LINKLISTEN = /^(linktr\.ee|linktree\.com|beacons\.ai|bio\.link|lnk\.bio|about\.me|carrd\.co|taplink\.cc|campsite\.bio|msha\.ke)$/;
const FREEMAIL = /^(gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|live\.com|yahoo\.com|icloud\.com|gmx\.(de|net|at|ch)|web\.de|t-online\.de|freenet\.de|posteo\.de|mail\.de)$/;
const BEHOERDE = /(^|\.)(bund\.de|gv\.at|admin\.ch|gov\.uk|europa\.eu|gov|bayern\.de|nrw\.de|niedersachsen\.de|hessen\.de|sachsen\.de|berlin\.de|hamburg\.de|bremen\.de|brandenburg\.de|thueringen\.de|saarland\.de|schleswig-holstein\.de|rlp\.de|baden-wuerttemberg\.de|sachsen-anhalt\.de|mv-regierung\.de)$/;
const HOCHSCHULE = /(^|\.)(edu|ac\.at|ac\.uk|ethz\.ch|epfl\.ch|uzh\.ch|unibe\.ch|unibas\.ch|tum\.de|lmu\.de|kit\.edu|rwth-aachen\.de)$|^(uni|fh|th|tu)-[a-z-]+\.(de|at|ch)$|hochschule|universitaet|universität/;
// Nur Unterseiten von Baukasten-/Blog-Diensten (name.wordpress.com), nie der Dienst
// selbst: wer bei WordPress oder Google arbeitet, hat die richtige Firmen-Domain.
const PLATTFORM = /\.(github\.io|wixsite\.com|jimdosite\.com|jimdofree\.com|wordpress\.com|blogspot\.com|substack\.com|notion\.site)$|^sites\.google\.com$/;

/** Grund, warum diese Domain keine Firmen-Website ist, sonst null. */
export function keineFirmenDomain(domain: string | null | undefined): string | null {
  const d = (domain ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (!d) return null;
  if (LINKLISTEN.test(d)) return "Linkliste statt Firmen-Website";
  if (FREEMAIL.test(d)) return "E-Mail-Anbieter statt Firmen-Website";
  if (BEHOERDE.test(d)) return "Behörde statt Firmen-Website";
  if (HOCHSCHULE.test(d)) return "Hochschule oder Forschungseinrichtung statt Firmen-Website";
  if (PLATTFORM.test(d)) return "Plattform statt eigener Firmen-Website";
  return null;
}
