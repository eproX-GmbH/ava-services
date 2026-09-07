// Fachlicher Fehler mit HTTP-Status fuer Tenant-/Organisations-/Abrechnungs-
// Operationen. Eigenes Modul, damit lib/tenants.ts und lib/seat-billing.ts
// sich gegenseitig importieren koennen, ohne einen Zyklus zur Modul-Ladezeit.

export class TenantError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
  }
}
