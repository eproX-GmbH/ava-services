// Generative UI (docs/PLAN_GENERATIVE_UI.md): json-render-Katalog der Oberflaeche.
// Props als zod-Schemas (zod/v4 aus zod 3.25, siehe electron.vite.config.ts),
// Beschreibungen aus shared/gen-ui/bausteine.ts (gleiche Quelle wie der Prompt).
// Bewusst nachsichtig (nullish): ein fehlendes Feld soll eine Kachel leerer machen,
// nicht die ganze Antwort verwerfen.

import { defineCatalog, type Catalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod/v4";
import { AKTIONEN, BAUSTEINE } from "../../../../../shared/gen-ui/bausteine";

const format = z.enum(["eur", "int", "num", "pct"]).nullish();
const zelle = z.union([z.string(), z.number(), z.null(), z.object({ text: z.string(), companyId: z.string().nullish(), personId: z.string().nullish() })]);

const props = {
  Karte: z.object({ titel: z.string().nullish(), untertitel: z.string().nullish() }),
  Raster: z.object({ spalten: z.number().int().min(1).max(4).nullish() }),
  Abschnitt: z.object({ titel: z.string().nullish() }),
  Text: z.object({ inhalt: z.string(), stil: z.enum(["normal", "gedaempft"]).nullish() }),
  Hinweis: z.object({ art: z.enum(["info", "warnung", "erfolg"]).nullish(), text: z.string() }),
  Marke: z.object({ text: z.string(), ton: z.enum(["neutral", "gut", "warnung", "schlecht", "marke"]).nullish() }),
  Kennzahlen: z.object({}),
  Kennzahl: z.object({
    label: z.string(),
    wert: z.union([z.string(), z.number()]),
    veraenderung: z.number().nullish(),
    vergleich: z.string().nullish(),
    verlauf: z.array(z.number()).nullish(),
  }),
  Verlauf: z.object({
    titel: z.string().nullish(),
    format,
    reihen: z.array(z.object({ name: z.string(), punkte: z.array(z.object({ x: z.union([z.string(), z.number()]), y: z.number() })) })),
    flaeche: z.boolean().nullish(),
  }),
  Balken: z.object({
    titel: z.string().nullish(),
    format,
    kategorien: z.array(z.string()),
    reihen: z.array(z.object({ name: z.string(), werte: z.array(z.number().nullable()) })),
  }),
  Rangliste: z.object({
    titel: z.string().nullish(),
    format,
    eintraege: z.array(z.object({ label: z.string(), wert: z.number(), hervorheben: z.boolean().nullish(), companyId: z.string().nullish() })),
  }),
  Ring: z.object({ titel: z.string().nullish(), format, anteile: z.array(z.object({ label: z.string(), wert: z.number() })) }),
  Tabelle: z.object({
    titel: z.string().nullish(),
    spalten: z.array(z.object({ titel: z.string(), typ: z.enum(["text", "zahl", "geld", "prozent", "veraenderung", "marke", "datum"]).nullish() })),
    zeilen: z.array(z.array(zelle)),
  }),
  Firmenkarte: z.object({ companyId: z.string(), grund: z.string().nullish(), score: z.number().nullish() }),
  Knopfreihe: z.object({}),
  Knopf: z.object({ label: z.string(), art: z.enum(["primaer", "sekundaer"]).nullish() }),
} as const;

export type GenUiName = keyof typeof props;
type Name = GenUiName;
/** Props-Typ je Baustein (fuer die Komponenten in bausteine.tsx). */
export type GenUiProps<N extends Name> = z.infer<(typeof props)[N]>;

function baustein<N extends Name>(name: N) {
  const b = BAUSTEINE[name]!;
  return {
    props: props[name],
    description: b.wofuer,
    ...(b.kinder || b.slots?.length ? { slots: ["default", ...(b.slots ?? [])] } : {}),
  };
}

// Typableitung bewusst abgeschaltet (as never / Catalog): defineCatalog mit 16
// zod-Schemas trieb tsc in einen Speicherueberlauf (2026-11-09). Geprueft wird
// zur Laufzeit gegen die Schemas (genUiKatalog.validate).
const daten = {
  components: {
    Karte: baustein("Karte"),
    Raster: baustein("Raster"),
    Abschnitt: baustein("Abschnitt"),
    Text: baustein("Text"),
    Hinweis: baustein("Hinweis"),
    Marke: baustein("Marke"),
    Kennzahlen: baustein("Kennzahlen"),
    Kennzahl: baustein("Kennzahl"),
    Verlauf: baustein("Verlauf"),
    Balken: baustein("Balken"),
    Rangliste: baustein("Rangliste"),
    Ring: baustein("Ring"),
    Tabelle: baustein("Tabelle"),
    Firmenkarte: baustein("Firmenkarte"),
    Knopfreihe: baustein("Knopfreihe"),
    Knopf: baustein("Knopf"),
  },
  actions: {
    oeffnen: { params: z.object({ ziel: z.string() }), description: AKTIONEN.oeffnen!.wofuer },
    auftrag: { params: z.object({ text: z.string() }), description: AKTIONEN.auftrag!.wofuer },
    link: { params: z.object({ url: z.string() }), description: AKTIONEN.link!.wofuer },
  },
};

export const genUiKatalog: Catalog = defineCatalog(schema, daten as never);

export type GenUiFormat = "eur" | "int" | "num" | "pct";
