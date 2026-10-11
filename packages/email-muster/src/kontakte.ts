// Antwort von GET /v1/companies/:id/contacts in die Sicht der E-Mail-Ableitung
// uebersetzen: Personen der Firma mit belastbaren und offenen Adressen, dazu die
// firmenweiten Adressen. Gemeinsam fuer den Hintergrund-Job (Desktop) und den
// Producer company-email (docs/PLAN_EMAIL_VERIFIZIERUNG.md, V0).

export interface PersonInfo {
  personId: string;
  fullName: string;
  title?: string | null;
  /** Belastbare Adressen (gefunden, verifiziert, zugeordnet, Catch-all). */
  emails: string[];
  /** Stufe 2: unverifizierte/abgelehnte Ableitungen — kein Beleg, nachpruefbar. */
  offeneEmails: string[];
}

export interface FirmenKontakte {
  name: string;
  websiteUrl: string | null;
  personen: PersonInfo[];
  /** Firmenweite E-Mail-Adressen (COMPANY-Fakten). */
  firmenEmails: string[];
}

export interface KontakteAntwort {
  companyName?: string | null;
  websiteUrl?: string | null;
  companyFacts?: Array<Record<string, unknown>>;
  companyObservations?: Array<Record<string, unknown>>;
  employments?: Array<Record<string, unknown>>;
}

/** Quelle einer abgeleiteten, aber nicht belastbaren Adresse (offen/abgelehnt). */
export const OFFENE_QUELLE = /^(pattern|zuordnung):(offen|abgelehnt)$/;

export function kontakteAusAntwort(companyId: string, r: KontakteAntwort): FirmenKontakte {
  // Quelle je Beobachtung: unverifizierte Ableitungen sind keine Belege.
  const quelle = new Map<string, string>();
  for (const o of r.companyObservations ?? []) if (typeof o.id === "string" && typeof o.source === "string") quelle.set(o.id, o.source);
  const istOffen = (f: Record<string, unknown>): boolean => OFFENE_QUELLE.test(quelle.get(String(f.lastObsId ?? "")) ?? "");
  const byPerson = new Map<string, PersonInfo>();
  const inFirma = new Set((r.employments ?? []).map((e) => String(e.personId ?? "")).filter(Boolean));
  const firmenEmails = new Set<string>();
  for (const f of r.companyFacts ?? []) {
    if (f.status !== "ACTIVE") continue;
    if (f.entityType === "COMPANY") {
      if (f.field === "email" && typeof f.value === "string" && f.value.includes("@")) firmenEmails.add(f.value.toLowerCase().trim());
      continue;
    }
    if (f.entityType !== "PERSON") continue;
    const pid = String(f.personId ?? f.entityId ?? "");
    if (!pid || (inFirma.size > 0 && !inFirma.has(pid))) continue;
    const p = byPerson.get(pid) ?? { personId: pid, fullName: "", emails: [], offeneEmails: [] };
    if (f.field === "fullName" && typeof f.value === "string" && !p.fullName) p.fullName = f.value;
    if (f.field === "jobTitle" && typeof f.value === "string" && !p.title) p.title = f.value;
    if (f.field === "email" && typeof f.value === "string") (istOffen(f) ? p.offeneEmails : p.emails).push(f.value.toLowerCase());
    byPerson.set(pid, p);
  }
  return {
    name: r.companyName ?? companyId,
    websiteUrl: r.websiteUrl ?? null,
    personen: [...byPerson.values()].filter((p) => p.fullName),
    firmenEmails: [...firmenEmails],
  };
}
