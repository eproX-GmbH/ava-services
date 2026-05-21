// v0.1.264 — Backward-compat-Wrapper.
//
// Die ursprüngliche v0.1.263-Implementierung wurde in write-objects.ts
// generalisiert (Companies + Contacts + Deals). Dieser Re-Export hält
// alle bestehenden Imports am Leben — neuer Code sollte direkt aus
// write-objects.ts importieren.

export {
  introspectHubspotCompany,
  updateHubspotCompany,
} from "./write-objects";

export type {
  HubspotPropertyOption,
  HubspotPropertySchema,
  IntrospectResult,
  UpdateInput,
  UpdateResult,
} from "./write-objects";
