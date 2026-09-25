// Verbrauch einer Anfrage (2026-09-25): "12 s · 8.450 Tokens · ≈ 0,02 $",
// waehrend der Arbeit live mit Laufzeit, danach dauerhaft an der Antwort.
// Vorbild ist die Statuszeile von Claude Code.

import { useEffect, useState } from "react";
import type { AgentTurnUsage } from "../../../shared/types";

const zahl = new Intl.NumberFormat("de-DE");

export function dauerText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, "0")} s`;
}

export function kostenText(usd: number | null | undefined): string | null {
  if (usd === null || usd === undefined) return null;
  if (usd === 0) return "0 $";
  if (usd < 0.01) return "< 0,01 $";
  return `≈ ${usd.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
}

export function tokensGesamt(u: AgentTurnUsage): number {
  return u.inputTokens + u.outputTokens;
}

function titel(u: AgentTurnUsage): string {
  return [
    u.model ? `Modell: ${u.model}` : null,
    `Eingabe: ${zahl.format(u.inputTokens)} Tokens${u.cacheReadTokens ? ` (davon ${zahl.format(u.cacheReadTokens)} aus dem Cache)` : ""}`,
    `Ausgabe: ${zahl.format(u.outputTokens)} Tokens`,
    `Modellaufrufe: ${u.steps}`,
    u.costUsd === null ? "Kosten: nicht zu beziffern (Abo oder unbekanntes Modell)" : null,
  ].filter(Boolean).join("\n");
}

/** Dauerhafte Zeile unter einer Antwort. */
export function VerbrauchZeile({ usage }: { usage: AgentTurnUsage }) {
  const teile = [dauerText(usage.durationMs), `${zahl.format(tokensGesamt(usage))} Tokens`, kostenText(usage.costUsd)].filter(Boolean);
  return <div className="verbrauch-zeile" title={titel(usage)}>{teile.join(" · ")}</div>;
}

/** Live-Zeile waehrend eine Anfrage laeuft. */
export function LaufStatus({ start, usage, laufend, text }: { start: number; usage: AgentTurnUsage | null; laufend: number; text: string }) {
  const [jetzt, setJetzt] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setJetzt(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const teile = [
    dauerText(jetzt - start),
    usage ? `${zahl.format(tokensGesamt(usage))} Tokens` : null,
    laufend > 0 ? `${laufend} ${laufend === 1 ? "laufendes Werkzeug" : "laufende Werkzeuge"}` : null,
    text,
  ].filter(Boolean);
  return (
    <div className="lauf-status" role="status" aria-live="polite" title={usage ? titel(usage) : undefined}>
      <span className="lauf-status__stern" aria-hidden="true" />
      <span>{teile.join(" · ")}</span>
    </div>
  );
}
