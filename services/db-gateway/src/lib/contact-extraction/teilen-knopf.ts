// Teilen-Knoepfe sind keine Profile der Firma.
//
// Fast jede Website hat eine Leiste "Seite teilen" mit Links zu Facebook,
// LinkedIn, XING oder WhatsApp. Die Extraktion hat sie als
// Social-Media-Profile der FIRMA gespeichert — also etwa
// `social:facebook = https://www.facebook.com/sharer/sharer.php?u=…`.
//
// Das ist doppelt falsch: Es ist kein Profil, und der Link fuehrt zurueck
// auf die Seite, von der er stammt. In der Firmenansicht steht dann ein
// vermeintliches Facebook-Profil, das niemanden irgendwohin bringt.
//
// Zwei Erkennungswege, absichtlich nebeneinander:
//
//   1. Bekannte Teilen-Pfade der grossen Anbieter. Trennscharf, aber nur
//      fuer das, was wir kennen.
//   2. Der allgemeine Verrat: Die Adresse traegt eine ANDERE Adresse als
//      Parameter mit (u=, url=, text=, link=). Genau das macht einen
//      Teilen-Knopf aus, und zwar unabhaengig vom Anbieter. Damit faellt
//      auch die naechste Variante auf, die wir noch nicht gesehen haben.

/** Pfade und Hosts, die bei den ueblichen Anbietern "teilen" bedeuten. */
const TEILEN_MUSTER: RegExp[] = [
  /facebook\.com\/sharer/i,
  /facebook\.com\/dialog\/(share|feed|send)/i,
  /linkedin\.com\/shareArticle/i,
  /linkedin\.com\/sharing\/share-offsite/i,
  /xing\.com\/(app\/user\?op=share|spi\/shares\/new)/i,
  /(api|web|wa\.me)\.?whatsapp\.com\/send/i,
  /wa\.me\/\?text=/i,
  /(twitter|x)\.com\/(intent\/(tweet|post)|share)/i,
  /t\.me\/share\/url/i,
  /pinterest\.[a-z.]+\/pin\/create/i,
  /reddit\.com\/submit/i,
  /tumblr\.com\/(widgets\/)?share/i,
  /vk\.com\/share\.php/i,
  /threads\.net\/intent/i,
  /mastodon[^/]*\/share/i,
  /service\.weibo\.com\/share/i,
  /addtoany\.com|sharethis\.com|addthis\.com/i,
];

/** Parameter, in denen ein Teilen-Knopf die zu teilende Adresse mitfuehrt. */
const ADRESS_PARAMETER = ["u", "url", "link", "text", "body", "mini", "source"];

/**
 * Ist diese Adresse ein Teilen-Knopf und damit kein Profil der Firma?
 *
 * Im Zweifel `false`: Ein uebersehener Teilen-Knopf ist ein Schoenheitsfehler,
 * ein faelschlich verworfenes echtes Profil ein Datenverlust.
 */
export function istTeilenKnopf(url: string | null | undefined): boolean {
  const roh = (url ?? "").trim();
  if (roh.length === 0) return false;

  if (TEILEN_MUSTER.some((m) => m.test(roh))) return true;

  // Traegt die Adresse eine andere Adresse als Parameter? Dann ist sie ein
  // Weiterreicher, kein Ziel.
  try {
    const u = new URL(roh);
    for (const p of ADRESS_PARAMETER) {
      const wert = u.searchParams.get(p);
      if (wert && /https?:\/\//i.test(wert)) return true;
    }
    // XING benutzt Semikolon statt kaufmaennisches Und: "?op=share;url=http…"
    if (/[?;&](url|u|link)=https?%3A|[?;&](url|u|link)=https?:/i.test(roh)) return true;
  } catch {
    // Keine auswertbare Adresse — dann entscheiden allein die Muster oben.
  }
  return false;
}
