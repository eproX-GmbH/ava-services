// Netzgrafik der Verflechtungen (2026-11-19, Joyce: „riesig und bulky“): radiales Layout in
// echten Pixeln statt einer hochskalierten Kraftsimulation. Die Wurzel sitzt im Ursprung,
// jede Entfernung im Netz (Breitensuche) ist ein Ring; der Ring waechst mit der Zahl seiner
// Knoten, aeussere Knoten liegen nahe ihrem Bezug. Rein und deterministisch (testbar).

export type NetzTyp = "FIRMA" | "PERSON";
export interface NetzKnoten {
  id: string;
  typ: NetzTyp;
  name: string;
  tiefe: number;
}
export interface NetzKante {
  von: string;
  nach: string;
}
export type Punkt = { x: number; y: number };

/** Masse der Knoten (Pixel). Personen sind Kreise, Firmen Kaesten mit Textbreite. */
export const PERSON_R = 11;
const ZEICHEN_PX = 6.6;
/** Firmenname in der Mitte: lang genug fuer „Berentzen-Gruppe Aktiengesellschaft“. */
export const WURZEL_ZEICHEN = 44;

export function kurz(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function knotenGroesse(k: NetzKnoten, istWurzel: boolean): { b: number; h: number } {
  if (k.typ === "PERSON") return { b: PERSON_R * 2, h: PERSON_R * 2 };
  const text = kurz(k.name, istWurzel ? WURZEL_ZEICHEN : 28);
  return istWurzel ? { b: Math.min(360, 28 + text.length * 7.3), h: 30 } : { b: Math.min(220, 22 + text.length * ZEICHEN_PX), h: 26 };
}

/** Breite der Beschriftung einer Person (Name plus Geburtsjahr), grob geschaetzt. */
export function labelBreite(text: string): number {
  return text.length * 6.4;
}

const ABSTAND_PERSON = 52;
const ABSTAND_FIRMA = 90;
const RING_MIN = 150;
const RING_SCHRITT = 140;
/** Ringe sind flache Ellipsen: Beschriftungen laufen waagerecht, Panels sind breit. */
const ELLIPSE = 1.55;

/** Halber Schritt neben „oben“: oben und unten sitzt kein Knoten genau auf der Achse. */
const START = -Math.PI / 2 + 0.17;

function winkelMittel(ws: number[]): number {
  let sx = 0;
  let sy = 0;
  for (const w of ws) {
    sx += Math.cos(w);
    sy += Math.sin(w);
  }
  return Math.atan2(sy, sx);
}

export function radialLayout(knoten: NetzKnoten[], kanten: NetzKante[], wurzel: string, label: (k: NetzKnoten) => string = (k) => k.name): Map<string, Punkt> {
  const pos = new Map<string, Punkt>();
  const ids = new Set(knoten.map((k) => k.id));
  const nachbarn = new Map<string, string[]>();
  for (const k of kanten) {
    if (!ids.has(k.von) || !ids.has(k.nach) || k.von === k.nach) continue;
    nachbarn.set(k.von, [...(nachbarn.get(k.von) ?? []), k.nach]);
    nachbarn.set(k.nach, [...(nachbarn.get(k.nach) ?? []), k.von]);
  }
  // Ring je Knoten: Abstand im Netz zur Wurzel; Unverbundene nach ihrer Tiefe aus dem Gateway.
  const ring = new Map<string, number>([[wurzel, 0]]);
  const schlange = [wurzel];
  while (schlange.length > 0) {
    const id = schlange.shift()!;
    for (const n of nachbarn.get(id) ?? []) {
      if (ring.has(n)) continue;
      ring.set(n, ring.get(id)! + 1);
      schlange.push(n);
    }
  }
  for (const k of knoten) if (!ring.has(k.id)) ring.set(k.id, Math.max(1, k.tiefe));
  const jeRing = new Map<number, NetzKnoten[]>();
  for (const k of knoten) {
    if (k.id === wurzel) continue;
    const r = ring.get(k.id)!;
    jeRing.set(r, [...(jeRing.get(r) ?? []), k]);
  }
  pos.set(wurzel, { x: 0, y: 0 });
  const winkel = new Map<string, number>([[wurzel, 0]]);
  let radius = 0;
  for (const r of [...jeRing.keys()].sort((a, b) => a - b)) {
    const liste = jeRing.get(r)!;
    const bedarf = liste.reduce((s, k) => s + (k.typ === "FIRMA" ? ABSTAND_FIRMA : ABSTAND_PERSON), 0);
    radius = Math.max(r === 1 ? RING_MIN : radius + RING_SCHRITT, bedarf / (2 * Math.PI));
    // Wunschwinkel: Ring 1 gleichmaessig (Firmen zuerst, dann nach Name), aussen nahe dem Bezug.
    const wunsch = new Map<string, number>();
    if (r === 1) {
      const sortiert = [...liste].sort((a, b) => (a.typ === b.typ ? a.name.localeCompare(b.name, "de") : a.typ === "FIRMA" ? -1 : 1));
      sortiert.forEach((k, i) => wunsch.set(k.id, START + (2 * Math.PI * i) / sortiert.length));
    } else {
      for (const k of liste) {
        const bezug = (nachbarn.get(k.id) ?? []).filter((n) => winkel.has(n) && (ring.get(n) ?? 0) < r).map((n) => winkel.get(n)!);
        wunsch.set(k.id, bezug.length > 0 ? winkelMittel(bezug) : 0);
      }
    }
    // Nach Wunschwinkel ordnen und Mindestabstand auf dem Ring erzwingen.
    const geordnet = [...liste].sort((a, b) => wunsch.get(a.id)! - wunsch.get(b.id)! || a.name.localeCompare(b.name, "de"));
    const schritt = geordnet.map((k) => (k.typ === "FIRMA" ? ABSTAND_FIRMA : ABSTAND_PERSON) / radius);
    const gesamt = schritt.reduce((a, b) => a + b, 0);
    const faktor = gesamt > 2 * Math.PI ? (2 * Math.PI) / gesamt : 1;
    let w = r === 1 ? START : wunsch.get(geordnet[0]!.id)!;
    geordnet.forEach((k, i) => {
      if (r > 1 && i > 0) w = Math.max(wunsch.get(k.id)!, w + (schritt[i - 1]! + schritt[i]!) * 0.5 * faktor);
      else if (r === 1 && i > 0) w += (2 * Math.PI) / geordnet.length;
      winkel.set(k.id, w);
      pos.set(k.id, { x: radius * ELLIPSE * Math.cos(w), y: radius * Math.sin(w) });
    });
  }
  entzerren(knoten, pos, wurzel, label);
  return pos;
}

/** Flaeche eines Knotens samt Beschriftung (Personen: Kreis plus Name daneben). */
export function flaeche(k: NetzKnoten, p: Punkt, istWurzel: boolean, label: string): { x0: number; y0: number; x1: number; y1: number } {
  const g = knotenGroesse(k, istWurzel);
  let x0 = p.x - g.b / 2;
  let x1 = p.x + g.b / 2;
  let y0 = p.y - g.h / 2;
  let y1 = p.y + g.h / 2;
  if (k.typ === "PERSON" && !istWurzel) {
    const l = labelLage(p);
    const b = labelBreite(label);
    const lx0 = l.anker === "start" ? l.x : l.anker === "end" ? l.x - b : l.x - b / 2;
    x0 = Math.min(x0, lx0);
    x1 = Math.max(x1, lx0 + b);
    y0 = Math.min(y0, l.y - 12);
    y1 = Math.max(y1, l.y + 4);
  }
  return { x0, y0, x1, y1 };
}

/** Ueberlappende Knoten (samt Beschriftung) auseinanderschieben; die Wurzel bleibt stehen. */
function entzerren(knoten: NetzKnoten[], pos: Map<string, Punkt>, wurzel: string, label: (k: NetzKnoten) => string): void {
  const LUFT = 6;
  for (let iter = 0; iter < 160; iter++) {
    let bewegt = false;
    for (let i = 0; i < knoten.length; i++) {
      for (let j = i + 1; j < knoten.length; j++) {
        const a = knoten[i]!;
        const b = knoten[j]!;
        const pa = pos.get(a.id)!;
        const pb = pos.get(b.id)!;
        const fa = flaeche(a, pa, a.id === wurzel, label(a));
        const fb = flaeche(b, pb, b.id === wurzel, label(b));
        const ox = Math.min(fa.x1, fb.x1) - Math.max(fa.x0, fb.x0) + LUFT;
        const oy = Math.min(fa.y1, fb.y1) - Math.max(fa.y0, fb.y0) + LUFT;
        if (ox <= 0 || oy <= 0) continue;
        bewegt = true;
        // Entlang der kleineren Ueberlappung trennen; die Wurzel bewegt sich nie.
        const anteilA = a.id === wurzel ? 0 : b.id === wurzel ? 1 : 0.5;
        const anteilB = 1 - anteilA;
        if (oy <= ox) {
          const r = (fa.y0 + fa.y1) / 2 <= (fb.y0 + fb.y1) / 2 ? -1 : 1;
          pos.set(a.id, { x: pa.x, y: pa.y + r * oy * anteilA });
          pos.set(b.id, { x: pb.x, y: pb.y - r * oy * anteilB });
        } else {
          const r = (fa.x0 + fa.x1) / 2 <= (fb.x0 + fb.x1) / 2 ? -1 : 1;
          pos.set(a.id, { x: pa.x + r * ox * anteilA, y: pa.y });
          pos.set(b.id, { x: pb.x - r * ox * anteilB, y: pb.y });
        }
      }
    }
    if (!bewegt) break;
  }
}

/** Punkt am Rand eines Knotens in Richtung `ziel` (Linien enden am Rand, nicht in der Mitte). */
export function randPunkt(mitte: Punkt, ziel: Punkt, groesse: { b: number; h: number }, kreis: boolean): Punkt {
  const dx = ziel.x - mitte.x;
  const dy = ziel.y - mitte.y;
  const len = Math.hypot(dx, dy) || 1;
  if (kreis) return { x: mitte.x + (dx / len) * (groesse.b / 2 + 1), y: mitte.y + (dy / len) * (groesse.b / 2 + 1) };
  const tx = Math.abs(dx) > 0.001 ? groesse.b / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const ty = Math.abs(dy) > 0.001 ? groesse.h / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const t = Math.min(tx, ty);
  return { x: mitte.x + dx * t, y: mitte.y + dy * t };
}

/** Beschriftung einer Person: nach aussen, weg von der Wurzel. */
export function labelLage(p: Punkt): { x: number; y: number; anker: "start" | "middle" | "end" } {
  const len = Math.hypot(p.x, p.y);
  if (len < 1) return { x: p.x, y: p.y + PERSON_R + 14, anker: "middle" };
  const c = p.x / len;
  const s = p.y / len;
  // Seitlich nach aussen; nur fast genau oben/unten mittig darueber bzw. darunter.
  if (c > 0.06) return { x: p.x + PERSON_R + 7, y: p.y + 4, anker: "start" };
  if (c < -0.06) return { x: p.x - PERSON_R - 7, y: p.y + 4, anker: "end" };
  return s > 0 ? { x: p.x, y: p.y + PERSON_R + 15, anker: "middle" } : { x: p.x, y: p.y - PERSON_R - 7, anker: "middle" };
}

/** Umriss aller Knoten samt Beschriftung (fuer Einpassen und Hoehe). */
export function umriss(knoten: NetzKnoten[], pos: Map<string, Punkt>, wurzel: string, label: (k: NetzKnoten) => string): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const k of knoten) {
    const p = pos.get(k.id);
    if (!p) continue;
    const g = knotenGroesse(k, k.id === wurzel);
    x0 = Math.min(x0, p.x - g.b / 2);
    x1 = Math.max(x1, p.x + g.b / 2);
    y0 = Math.min(y0, p.y - g.h / 2);
    y1 = Math.max(y1, p.y + g.h / 2);
    if (k.typ === "PERSON") {
      const l = labelLage(p);
      const b = labelBreite(label(k));
      const lx0 = l.anker === "start" ? l.x : l.anker === "end" ? l.x - b : l.x - b / 2;
      x0 = Math.min(x0, lx0);
      x1 = Math.max(x1, lx0 + b);
      y0 = Math.min(y0, l.y - 12);
      y1 = Math.max(y1, l.y + 4);
    }
  }
  if (!Number.isFinite(x0)) return { x0: -100, y0: -100, x1: 100, y1: 100 };
  return { x0, y0, x1, y1 };
}
