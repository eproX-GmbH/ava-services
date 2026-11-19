// Firmenhistorie H4: reine Zaehlung der Fluktuation (ohne Datenbank, testbar). Regeln in fluktuation.ts.

import type { Rollengruppe, Ebene } from "./rollengruppe";

export interface ZaehlEreignis {
  art: "neu" | "verlassen" | "wechsel" | "geschaeftsfuehrung";
  gruppe: Rollengruppe;
  ebene: Ebene;
  gruppeVorher: Rollengruppe | null;
  ebeneVorher: Ebene | null;
}

const LEITUNG_TEXT: Record<Rollengruppe, string> = {
  geschaeftsfuehrung: "Geschäftsführung",
  aufsicht: "Aufsichtsrat/Beirat",
  vertrieb: "Vertriebsleitung",
  marketing: "Marketingleitung",
  einkauf: "Einkaufsleitung",
  it: "IT-Leitung",
  personal: "Personalleitung",
  finanzen: "Finanzleitung",
  technik: "Technische Leitung",
  service: "Serviceleitung",
  sonstige: "Sonstige Leitung",
};

export type Zaehlbar = ZaehlEreignis;

export interface FluktuationGruppe {
  gruppe: Rollengruppe;
  label: string;
  zugaenge: number;
  abgaenge: number;
  wechsel: number;
}

/** Reine Zaehlung (testbar): Zu-/Abgaenge der Leitung je Rollengruppe. */
export function leitungZaehlen(ereignisse: Zaehlbar[], register: { zu: number; ab: number } = { zu: 0, ab: 0 }): FluktuationGruppe[] {
  const zu = new Map<Rollengruppe, number>();
  const ab = new Map<Rollengruppe, number>();
  const plus = (m: Map<Rollengruppe, number>, g: Rollengruppe) => m.set(g, (m.get(g) ?? 0) + 1);
  for (const e of ereignisse) {
    const jetztLeitung = e.ebene === "leitung";
    const vorherLeitung = e.ebeneVorher === "leitung";
    if (e.art === "neu" && jetztLeitung) plus(zu, e.gruppe);
    else if (e.art === "verlassen" && jetztLeitung) plus(ab, e.gruppe);
    else if (e.art === "wechsel") {
      const gleich = e.gruppe === e.gruppeVorher && jetztLeitung === vorherLeitung;
      if (gleich) continue;
      if (jetztLeitung) plus(zu, e.gruppe);
      if (vorherLeitung && e.gruppeVorher) plus(ab, e.gruppeVorher);
    }
  }
  zu.set("geschaeftsfuehrung", Math.max(zu.get("geschaeftsfuehrung") ?? 0, register.zu));
  ab.set("geschaeftsfuehrung", Math.max(ab.get("geschaeftsfuehrung") ?? 0, register.ab));
  const gruppen = new Set<Rollengruppe>([...zu.keys(), ...ab.keys()]);
  return [...gruppen]
    .filter((g) => g !== "sonstige")
    .map((g) => {
      const z = zu.get(g) ?? 0;
      const a = ab.get(g) ?? 0;
      return { gruppe: g, label: LEITUNG_TEXT[g], zugaenge: z, abgaenge: a, wechsel: Math.max(z, a) };
    })
    .filter((g) => g.wechsel > 0)
    .sort((a, b) => b.wechsel - a.wechsel || a.label.localeCompare(b.label, "de"));
}

/**
 * Hinweise nur, wo es auffaellt, und mit ehrlichen Zahlen statt „gewechselt“: Drei neue
 * Leitungen ohne Abgang sind eher Wachstum als Wechsel (Probe 2026-11-19). Auffaellig:
 * Zu- und Abgaenge zusammen ab 3 (Geschaeftsfuehrung ab 2), oder ab 2 Abgaengen. Hoechstens 3.
 */
export function hinweiseAus(gruppen: FluktuationGruppe[], monate: number): string[] {
  const zeit = monate % 12 === 0 ? `${monate / 12 === 1 ? "einem Jahr" : `${monate / 12} Jahren`}` : `${monate} Monaten`;
  return gruppen
    .filter((g) => g.zugaenge + g.abgaenge >= (g.gruppe === "geschaeftsfuehrung" ? 2 : 3) || g.abgaenge >= 2)
    .sort((a, b) => b.zugaenge + b.abgaenge - (a.zugaenge + a.abgaenge))
    .slice(0, 3)
    .map((g) => {
      const teile = [g.zugaenge > 0 ? `${g.zugaenge} neu` : null, g.abgaenge > 0 ? `${g.abgaenge} ausgeschieden` : null].filter(Boolean);
      return `${g.label}: ${teile.join(", ")} in ${zeit}`;
    });
}
