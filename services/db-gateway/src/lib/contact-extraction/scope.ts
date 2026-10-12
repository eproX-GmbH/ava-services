// Firmenbezug von Personen-Fakten (2026-10-12, docs/PLAN_EMAIL_VERIFIZIERUNG.md §8.6).
//
// Eine Person ist EIN Datensatz (Identitaet ueber Profil-URL bzw. Name je
// Firma). Wo sie erreichbar ist und was sie tut, gilt aber je Firma: Joyce hat
// bei QUIKK joyce@quikk.de und bei Strategic IT eine eigene Adresse. Deshalb
// tragen Kontakt- und Rollenfakten die Firma im Eindeutigkeitsschluessel
// (Fact.scopeCompanyId); Identitaetsfakten und Firmenfakten bleiben "".

/** Personen-Felder, die je Firma gelten. */
export const PERSON_FIRMENFELDER = new Set(["email", "phone", "jobTitle", "department", "employmentSince", "websiteBeschreibung", "seniority"]);

export function factScope(entityType: "COMPANY" | "PERSON", field: string, companyId: string | null | undefined): string {
  return entityType === "PERSON" && companyId && PERSON_FIRMENFELDER.has(field) ? companyId : "";
}
