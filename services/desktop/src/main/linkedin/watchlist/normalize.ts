// WL1 — LinkedIn-Profil-Normalisierung (Desktop-Zwilling der
// Gateway-Funktion in contact-extraction/employee-contact.ts; gleiche
// Semantik, gleiche kanonische Form — bei Aenderungen BEIDE anpassen).
//
// Nur /in/-Profile zaehlen; kanonische Form:
//   https://www.linkedin.com/in/<slug>  (Slug decodiert, lowercase,
//   wieder encodiert; Laender-Subdomain → www; Slash/Query/Locale weg).
// Kurzlinks (lnkd.in) und alles andere → null.

export function normalizeLinkedInProfileUrl(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  // Menschliche Eingaben kommen oft ohne Schema ("linkedin.com/in/x") —
  // tolerieren statt ablehnen.
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const m = /^\/in\/([^/]+)/.exec(u.pathname);
  if (!m || !m[1]) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]).trim().toLowerCase();
  } catch {
    slug = m[1].trim().toLowerCase();
  }
  if (!slug) return null;
  return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
}
