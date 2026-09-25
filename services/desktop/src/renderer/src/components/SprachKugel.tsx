// Sprachmodus — die Sprachkugel (docs/PLAN_SPRACHMODUS.md, Abschnitt 4).
//
// Canvas mit weichem Verlauf. Grundgroesse und Farbe haengen am Zustand,
// der Pegel moduliert die Groesse. Alles gleitet (Tiefpass), damit nichts
// springt. prefers-reduced-motion: nur Farbe, keine Bewegung.

import { useEffect, useRef } from "react";

export type KugelZustand = "ruhe" | "verbindet" | "wach" | "hoert" | "denkt" | "spricht";

export function SprachKugel({ zustand, pegel, eingang, countdown, size = 360 }: {
  zustand: KugelZustand;
  /** 0..1 Ausgabepegel (AVA spricht). */
  pegel: number;
  /** 0..1 Mikrofonpegel (Nutzer spricht). */
  eingang: number;
  /** Sekunden bis zum Ruhezustand, wenn ≤ 8; sonst null. */
  countdown: number | null;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const werte = useRef({ r: 0.6, hell: 0.6, pegel: 0, eingang: 0 });
  const props = useRef({ zustand, pegel, eingang, countdown });
  props.current = { zustand, pegel, eingang, countdown };

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr; c.height = size * dpr;
    const g = c.getContext("2d");
    if (!g) return;
    const ruhig = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let t0 = performance.now();
    const tick = (t: number) => {
      const { zustand: z, pegel: p, eingang: e, countdown: cd } = props.current;
      const dt = Math.min(0.05, (t - t0) / 1000); t0 = t;
      const w = werte.current;
      const ziel = z === "ruhe" ? { r: 0.42, hell: 0.35 } : z === "verbindet" ? { r: 0.6, hell: 0.6 } : z === "hoert" ? { r: 0.78, hell: 0.72 } : z === "denkt" ? { r: 0.86, hell: 0.9 } : z === "spricht" ? { r: 0.95, hell: 1 } : { r: 0.9, hell: 0.95 };
      const k = 1 - Math.exp(-dt * 6);
      w.r += (ziel.r - w.r) * k;
      w.hell += (ziel.hell - w.hell) * k;
      w.pegel += (p - w.pegel) * (1 - Math.exp(-dt * 14));
      w.eingang += (e - w.eingang) * (1 - Math.exp(-dt * 10));
      const atem = ruhig ? 0 : Math.sin(t / 1400) * 0.02;
      const puls = !ruhig && (z === "denkt" || z === "verbindet") ? Math.sin(t / 380) * 0.04 : 0;
      const wachs = ruhig ? 0 : z === "spricht" ? w.pegel * 0.28 : z === "hoert" ? -w.eingang * 0.12 : 0;
      const radius = (size * 0.5) * 0.72 * (w.r + atem + puls + wachs);

      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, size, size);
      const cx = size / 2, cy = size / 2;
      const hell = w.hell;
      const dunkel = document.documentElement.classList.contains("dark");
      // AVA-Aqua (Brand-Palette: 50 #e6faf6, 200 #7ee2cf, 400 #14c8ad,
      // 500 #00c0a7, 600 #009f8a). Im Ruhezustand entsaettigt und gedaempft.
      const s = z === "ruhe" ? 0.35 : 1;
      const mix = (a: number[], b: number[], t: number) => a.map((x, i) => Math.round(x + (b[i]! - x) * t));
      const grau = [148, 163, 184];
      const hl = mix(grau, [230, 250, 246], s), mitte = mix(grau, [126, 226, 207], s), rand = mix(grau, [0, 159, 138], s), glanz = mix(grau, [0, 192, 167], s);
      const f = (c: number[], m: number) => `rgb(${c.map((x) => Math.round(x * m)).join(",")})`;
      const lum = 0.55 + 0.45 * hell;
      // Aussenschein
      const schein = g.createRadialGradient(cx, cy, radius * 0.8, cx, cy, radius * 1.4);
      schein.addColorStop(0, `rgba(${glanz.join(",")}, ${(dunkel ? 0.32 : 0.22) * hell})`);
      schein.addColorStop(1, `rgba(${glanz.join(",")}, 0)`);
      g.fillStyle = schein; g.beginPath(); g.arc(cx, cy, radius * 1.4, 0, Math.PI * 2); g.fill();
      // Kugel mit Lichtpunkt oben links
      const grad = g.createRadialGradient(cx - radius * 0.35, cy - radius * 0.42, radius * 0.08, cx, cy, radius);
      grad.addColorStop(0, f(hl, lum));
      grad.addColorStop(0.5, f(mitte, lum));
      grad.addColorStop(1, f(rand, lum));
      g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, radius, 0, Math.PI * 2); g.fill();
      // Countdown-Ring in den letzten Sekunden vor dem Ruhezustand
      if (cd !== null && cd > 0) {
        const anteil = Math.min(1, cd / 8);
        g.strokeStyle = `rgba(0, 159, 138, ${0.35 + 0.45 * (1 - anteil)})`;
        g.lineWidth = 3;
        g.beginPath(); g.arc(cx, cy, radius * 1.12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * anteil); g.stroke();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={ref} className="sk-kugel" style={{ width: size, height: size }} aria-hidden="true" />;
}
