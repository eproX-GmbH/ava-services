// KI-Urteil fuer Zuordnung, Muster und Alias-Domain (zuordnung.ts/domain.ts)
// ueber den LLM-Provider des Producers (@ava/ai-provider, Umgebung vom
// Supervisor). Ohne Modell oder bei Fehlern: ohne Urteil weiterarbeiten.

import { getLLM, textErzeugen } from "@ava/ai-provider";
import type { Urteil } from "@ava/email-muster";
import { logger } from "./log";

export function makeUrteil(): Urteil | null {
  let model: unknown;
  try {
    model = getLLM();
  } catch (e) {
    logger.info(`kein KI-Urteil verfuegbar (${e instanceof Error ? e.message : String(e)}) — nur deterministische Zuordnung`);
    return null;
  }
  return async (system, user) => {
    try {
      const r = await textErzeugen({ model, system, prompt: user });
      return r.text;
    } catch (e) {
      logger.error(`KI-Urteil fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
}
