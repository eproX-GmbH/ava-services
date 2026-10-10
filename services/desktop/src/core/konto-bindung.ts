// Kontobindung einer bereitgestellten Server-Instanz (docs/PLAN_AVA_CLOUD.md §14).
// `AVA_KONTO` (E-Mail oder Konto-ID) setzt das Bereitstellungsskript. Die Prüfung
// läuft in der Anmeldung selbst (Auth.applyTokens), bevor die Sitzung gilt: ein
// fremdes Konto wird nie „angemeldet“, also startet auch nichts in seinem Namen.
// Ohne `AVA_KONTO` (Desktop, eigene Instanz des Operators) gibt es keine Bindung.

export const GEBUNDENES_KONTO = process.env.AVA_KONTO?.trim().toLowerCase() || null;

/** Begründung, wenn dieses Konto hier nicht angemeldet sein darf; sonst null. */
export function kontoAbweisung(k: { email: string | null; actorId: string | null }): string | null {
  if (!GEBUNDENES_KONTO) return null;
  if ([k.email?.toLowerCase(), k.actorId?.toLowerCase()].includes(GEBUNDENES_KONTO)) return null;
  return `Diese AVA ist für ${GEBUNDENES_KONTO} eingerichtet; angemeldet hatte sich ${k.email ?? k.actorId ?? "ein anderes Konto"}. Bitte mit dem richtigen Konto bestätigen.`;
}
