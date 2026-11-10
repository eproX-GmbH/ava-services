// Side-effect-only: direkt nach account-space-init (das Update-Flag liegt im
// Konto-Space). Siehe update-start-sperre.ts.
import { pruefeUpdateStartSperre } from "./update-start-sperre";

pruefeUpdateStartSperre();
