// Kleine Kraftsimulation fuer Personen-Karten, deterministisch (kein Zufall).
//
// Herausgeloest aus dem Verflechtungen-Graphen, damit die Buying-Center-
// Karte dasselbe Verhalten hat: gleiche Abstossung, gleiche Kantenlaenge,
// gleiche Grenzen. Der Verflechtungen-Graph behaelt vorerst seine eigene
// Kopie — die beiden sollen zusammenwachsen, aber nicht in demselben Schritt,
// in dem die Karte entsteht.
//
// Was hier anders ist als dort: Es gibt keine Tiefe (alle Personen liegen
// auf einer Ebene), und bekannte Startpositionen werden uebernommen, damit
// eine gespeicherte Anordnung nach dem Neuladen so aussieht wie verlassen.

export type Punkt = { x: number; y: number };

export function kraftLayout(
  ids: string[],
  kanten: Array<{ von: string; nach: string }>,
  breite: number,
  hoehe: number,
  bekannt: Map<string, Punkt> = new Map(),
): Map<string, Punkt> {
  const cx = breite / 2;
  const cy = hoehe / 2;
  const pos = new Map<string, Punkt>();
  // Start: Kreis um die Mitte, Bekanntes bleibt liegen.
  const r = Math.min(breite, hoehe) * 0.32;
  ids.forEach((id, i) => {
    const b = bekannt.get(id);
    if (b) pos.set(id, b);
    else {
      const w = (2 * Math.PI * i) / Math.max(ids.length, 1) - Math.PI / 2;
      pos.set(id, { x: cx + r * Math.cos(w), y: cy + r * Math.sin(w) });
    }
  });
  // Alles bekannt: nichts rechnen — sonst wandert Gespeichertes.
  if (ids.every((id) => bekannt.has(id))) return pos;

  const idx = new Map(ids.map((id, i) => [id, i]));
  const p = ids.map((id) => pos.get(id)!);
  const fest = ids.map((id) => bekannt.has(id));
  const vx = new Float64Array(ids.length);
  const vy = new Float64Array(ids.length);
  const kantenIdx = kanten
    .map((k) => [idx.get(k.von), idx.get(k.nach)] as const)
    .filter(([a, b]) => a !== undefined && b !== undefined) as Array<readonly [number, number]>;

  for (let iter = 0; iter < 260; iter++) {
    const temp = 1 - iter / 260;
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) {
        let dx = p[j]!.x - p[i]!.x;
        let dy = p[j]!.y - p[i]!.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = 0.5; dy = 0.5; d2 = 0.5; }
        // Staerker als im Verflechtungen-Graphen: Hier haengt unter jedem
        // Knoten zweizeilig Text, der Platz braucht.
        const f = 16000 / d2;
        const fx = (dx / Math.sqrt(d2)) * f;
        const fy = (dy / Math.sqrt(d2)) * f;
        vx[i]! -= fx; vy[i]! -= fy; vx[j]! += fx; vy[j]! += fy;
      }
    }
    for (const [a, b] of kantenIdx) {
      const dx = p[b]!.x - p[a]!.x;
      const dy = p[b]!.y - p[a]!.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 230) * 0.02;
      vx[a]! += (dx / d) * f; vy[a]! += (dy / d) * f;
      vx[b]! -= (dx / d) * f; vy[b]! -= (dy / d) * f;
    }
    for (let i = 0; i < p.length; i++) {
      if (fest[i]) { vx[i] = 0; vy[i] = 0; continue; }
      // Zur Mitte ziehen, senkrecht staerker als waagerecht: Die Karte ist
      // breiter als hoch, und ein rundes Knaeuel verschenkt die Breite.
      const sx = vx[i]! + (cx - p[i]!.x) * 0.0025;
      const sy = vy[i]! + (cy - p[i]!.y) * 0.007;
      p[i] = {
        x: Math.min(breite - 80, Math.max(80, p[i]!.x + Math.max(-12, Math.min(12, sx * temp)))),
        y: Math.min(hoehe - 40, Math.max(40, p[i]!.y + Math.max(-12, Math.min(12, sy * temp)))),
      };
      vx[i] = sx * 0.6; vy[i] = sy * 0.6;
    }
  }
  ids.forEach((id, i) => pos.set(id, p[i]!));
  return pos;
}
