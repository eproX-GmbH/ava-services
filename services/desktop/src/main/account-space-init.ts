// Side-effect-only Bootstrap: Account-Space waehlen, BEVOR irgendein
// Store `app.getPath("userData")` liest. Muss in main/index.ts direkt
// nach file-logger-init importiert werden (Logging soll schon laufen,
// Stores duerfen noch nicht existieren).
import { initAccountSpace } from "./account-space";

initAccountSpace();
