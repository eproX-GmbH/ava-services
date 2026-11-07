// Loesungskarten (docs/PLAN_LOESUNGSKARTEN.md, L3): Format und Leser.
// Eine Karte ist eine Markdown-Datei mit YAML-Kopf (zwischen zwei "---"-Zeilen)
// und der Loesung als Text darunter. Beschreibung fuer Autoren: karten/README.md.

import * as yup from "yup";
import { parse as yamlParse } from "yaml";

/** Ziele, die app_oeffnen kennt (agent/tools/app-oeffnen.ts). */
export const AKTION_ARTEN = ["app_oeffnen", "zugang_anfordern", "chat_vorschlag"] as const;
export const KANAELE = ["desktop", "telegram", "app", "alle"] as const;

export interface KartenAktion {
  art: (typeof AKTION_ARTEN)[number];
  label: string;
  /** app_oeffnen: Ziel (z. B. dienst_verbinden); chat_vorschlag: Auftrag als Text. */
  ziel?: string;
  /** app_oeffnen/zugang_anfordern: Dienst (z. B. compleadly). */
  dienst?: string;
}

export interface Karte {
  id: string;
  titel: string;
  fragen: string[];
  schlagworte: string[];
  aktionen: KartenAktion[];
  gilt_fuer: Array<(typeof KANAELE)[number]>;
  stand: string;
  loesung: string;
  /** Herkunft (Dateipfad), fuer Fehlermeldungen. */
  quelle: string;
}

const kopfSchema = yup
  .object({
    id: yup.string().trim().matches(/^[a-z0-9][a-z0-9-]{1,80}$/, "id: nur a-z, 0-9 und Bindestrich").required(),
    titel: yup.string().trim().min(4).max(140).required(),
    fragen: yup.array(yup.string().trim().min(2).max(200).required()).min(1, "mindestens eine Beispielfrage").max(20).required(),
    schlagworte: yup.array(yup.string().trim().min(2).max(60).required()).max(30).default([]),
    aktionen: yup
      .array(
        yup
          .object({
            art: yup.string().oneOf([...AKTION_ARTEN]).required(),
            label: yup.string().trim().min(2).max(40).required(),
            ziel: yup.string().trim().max(400).optional(),
            dienst: yup.string().trim().max(60).optional(),
          })
          .noUnknown(true),
      )
      .max(4)
      .default([]),
    gilt_fuer: yup.array(yup.string().oneOf([...KANAELE]).required()).min(1).default(["alle"]),
    stand: yup
      .string()
      .trim()
      .matches(/^\d{4}-\d{2}-\d{2}$/, "stand: JJJJ-MM-TT")
      .required(),
  })
  .noUnknown(true, "unbekanntes Feld im Kopf");

const KOPF_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/** Liest eine Karte; wirft mit verstaendlicher Meldung, wenn sie nicht passt. */
export function karteLesen(text: string, quelle: string): Karte {
  const m = KOPF_RE.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new Error(`${quelle}: Kopf zwischen zwei "---"-Zeilen fehlt`);
  let roh: unknown;
  try {
    roh = yamlParse(m[1]!);
  } catch (err) {
    throw new Error(`${quelle}: Kopf ist kein gültiges YAML (${err instanceof Error ? err.message : String(err)})`);
  }
  if (roh && typeof roh === "object" && "stand" in roh && (roh as { stand: unknown }).stand instanceof Date) {
    (roh as { stand: unknown }).stand = ((roh as { stand: Date }).stand).toISOString().slice(0, 10);
  }
  let kopf: yup.InferType<typeof kopfSchema>;
  try {
    kopf = kopfSchema.validateSync(roh, { abortEarly: false, stripUnknown: false });
  } catch (err) {
    const fehler = err instanceof yup.ValidationError ? err.errors.join("; ") : String(err);
    throw new Error(`${quelle}: ${fehler}`);
  }
  const loesung = m[2]!.trim();
  if (loesung.length < 20) throw new Error(`${quelle}: Lösungstext fehlt oder ist zu kurz`);
  if (loesung.length > 2400) throw new Error(`${quelle}: Lösungstext zu lang (höchstens 2400 Zeichen, eine Karte = ein Problem)`);
  for (const a of kopf.aktionen) {
    if (a.art === "app_oeffnen" && !a.ziel) throw new Error(`${quelle}: Aktion app_oeffnen braucht ziel`);
    if (a.art === "chat_vorschlag" && !a.ziel) throw new Error(`${quelle}: Aktion chat_vorschlag braucht ziel (den Auftrag)`);
  }
  return {
    id: kopf.id,
    titel: kopf.titel,
    fragen: kopf.fragen,
    schlagworte: kopf.schlagworte,
    aktionen: kopf.aktionen as KartenAktion[],
    gilt_fuer: kopf.gilt_fuer as Karte["gilt_fuer"],
    stand: kopf.stand,
    loesung,
    quelle,
  };
}

/** Alle Karten lesen; doppelte ids und kaputte Karten werden gemeldet, nicht verschluckt. */
export function kartenLesen(dateien: Array<{ pfad: string; text: string }>): { karten: Karte[]; fehler: string[] } {
  const karten: Karte[] = [];
  const fehler: string[] = [];
  const ids = new Map<string, string>();
  for (const d of dateien) {
    try {
      const k = karteLesen(d.text, d.pfad);
      const vorher = ids.get(k.id);
      if (vorher) {
        fehler.push(`${d.pfad}: id "${k.id}" gibt es schon in ${vorher}`);
        continue;
      }
      ids.set(k.id, d.pfad);
      karten.push(k);
    } catch (err) {
      fehler.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { karten, fehler };
}
