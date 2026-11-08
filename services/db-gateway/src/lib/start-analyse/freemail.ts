// Onboarding O1 (docs/PLAN_ONBOARDING.md): Freemail- und Baukasten-Domains werden
// bei der Start-Analyse nicht verarbeitet. Kopie in der App:
// services/desktop/src/shared/freemail.ts (gleiche Liste, bei Aenderung beide pflegen).

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.de", "hotmail.com", "hotmail.de", "live.com", "live.de", "msn.com",
  "yahoo.com", "yahoo.de", "ymail.com", "rocketmail.com", "icloud.com", "me.com", "mac.com", "aol.com", "aol.de",
  "gmx.de", "gmx.net", "gmx.at", "gmx.ch", "gmx.com", "web.de", "t-online.de", "freenet.de", "arcor.de", "online.de",
  "1und1.de", "email.de", "posteo.de", "posteo.net", "mailbox.org", "proton.me", "protonmail.com", "protonmail.ch",
  "pm.me", "tutanota.com", "tutanota.de", "tuta.io", "zoho.com", "yandex.com", "yandex.ru", "mail.ru", "mail.com",
  "bluewin.ch", "gmx.li", "hispeed.ch", "sunrise.ch", "aon.at", "chello.at", "a1.net", "kabelmail.de", "vodafone.de",
  "magenta.de", "o2online.de", "unitybox.de", "netcologne.de", "ewe.net", "htp-tel.de", "osnanet.de", "versanet.de",
  "fastmail.com", "hey.com", "gmx.org", "googlemail.de",
]);

// Baukasten-/Massenhoster wie in lib/web-firma.ts: keine eigene Firmen-Website.
const BAUKASTEN = /(^|\.)(jimdo|jimdofree|wix|wixsite|weebly|webnode|site123|strikingly|squarespace|wordpress|blogspot|business\.site|carrd|github\.io|netlify\.app|vercel\.app)\.[a-z.]+$/i;

export function domainAusEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const d = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

export function istFreemail(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return FREEMAIL.has(d) || BAUKASTEN.test(d);
}
