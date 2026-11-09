// Loesungskarten: Format der beigelegten Kartenvektoren (vektoren.json).
// Erzeugt beim Entwickeln mit scripts/wissen-vektoren.mts, nie auf dem Geraet
// des Nutzers. Modell und Gewichte sind dieselben wie in der App
// (REQUIRED_MODELS: embeddinggemma:latest, Ollama-Pin aus ollama-pin.ts).
// Vektoren als Float32 little-endian in Base64 (je Karte 768 Werte).

import type { Vorberechnet } from "./suche";

export const VEKTOR_MODELL = "embeddinggemma:latest";
/** Manifest-Digest von embeddinggemma:latest, mit dem die App rechnet. */
export const VEKTOR_MODELL_DIGEST = "82f094e4c0e19bc4208c692996d4f1ecf14e82a8dee579ee1d2ca1175260058e";

export interface VektorDatei {
  modell: string;
  digest: string;
  ollama: string;
  dim: number;
  karten: Record<string, { hash: string; v: string }>;
}

export function vektorKodieren(v: number[]): string {
  return Buffer.from(new Float32Array(v).buffer).toString("base64");
}

export function vektorDekodieren(b64: string): number[] {
  const roh = Buffer.from(b64, "base64");
  const kopie = new Uint8Array(roh.byteLength);
  kopie.set(roh);
  return Array.from(new Float32Array(kopie.buffer));
}

/** Datei → Vektoren je Karte; anderes Modell = keine Vektoren (nur Volltext). */
export function vektorenAusDatei(d: VektorDatei | null | undefined): Vorberechnet {
  if (!d || d.modell !== VEKTOR_MODELL || d.digest !== VEKTOR_MODELL_DIGEST) return {};
  const out: Vorberechnet = {};
  for (const [id, e] of Object.entries(d.karten)) out[id] = { hash: e.hash, vektor: vektorDekodieren(e.v) };
  return out;
}
