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
      // Aussenschein
      const schein = g.createRadialGradient(cx, cy, radius * 0.85, cx, cy, radius * 1.35);
      schein.addColorStop(0, `rgba(120, 140, 255, ${0.18 * hell})`);
      schein.addColorStop(1, "rgba(120, 140, 255, 0)");
      g.fillStyle = schein; g.beginPath(); g.arc(cx, cy, radius * 1.35, 0, Math.PI * 2); g.fill();
      // Kugel: hell blau-weiss wie das Vorbild, im Ruhezustand grau-blau
      const grad = g.createRadialGradient(cx - radius * 0.35, cy - radius * 0.45, radius * 0.1, cx, cy, radius);
      const s = z === "ruhe" ? 0.45 : 1;
      grad.addColorStop(0, `rgba(${Math.round(250 * hell)}, ${Math.round(252 * hell)}, 255, 1)`);
      grad.addColorStop(0.55, `rgba(${Math.round((200 + 20 * s) * hell)}, ${Math.round((212 + 10 * s) * hell)}, ${Math.round(255 * Math.max(hell, 0.6))}, 1)`);
      grad.addColorStop(1, `rgba(${Math.round((140 - 40 * (1 - s)) * hell)}, ${Math.round((160 - 30 * (1 - s)) * hell)}, ${Math.round(245 * Math.max(hell, 0.55))}, 1)`);
      g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, radius, 0, Math.PI * 2); g.fill();
      // Countdown-Ring in den letzten Sekunden vor dem Ruhezustand
      if (cd !== null && cd > 0) {
        const anteil = Math.min(1, cd / 8);
        g.strokeStyle = `rgba(90, 110, 240, ${0.35 + 0.4 * (1 - anteil)})`;
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
