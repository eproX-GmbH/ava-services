// Generative UI (docs/PLAN_GENERATIVE_UI.md): Textfassung eines ```spec-Zauns fuer
// Kanaele ohne Oberflaeche (Telegram, spaeter MCP/A2A und Mail). Liest die
// JSON-Patch-Zeilen selbst (ohne json-render), damit der Hauptprozess frei davon
// bleibt. Nie rohes JSON nach aussen.

type El = { type?: string; props?: Record<string, unknown>; children?: string[]; slots?: Record<string, string[]> };

const SPEC_ZAUN_RE = /```spec\s*\n([\s\S]*?)(?:\n```|$)/g;

function elementeAus(raw: string): { root: string | null; elemente: Record<string, El> } {
  let root: string | null = null;
  const elemente: Record<string, El> = {};
  for (const zeile of raw.split("\n")) {
    const t = zeile.trim();
    if (!t.startsWith("{")) continue;
    try {
      const op = JSON.parse(t) as { op?: string; path?: string; value?: unknown };
      if (op.op !== "add" && op.op !== "replace") continue;
      if (op.path === "/root" && typeof op.value === "string") root = op.value;
      const m = /^\/elements\/([^/]+)$/.exec(op.path ?? "");
      if (m && op.value && typeof op.value === "object") elemente[m[1]!] = op.value as El;
    } catch {
      /* unvollstaendige Zeile */
    }
  }
  return { root, elemente };
}

const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? v.toLocaleString("de-DE") : "");

function zeilenFuer(el: El): string[] {
  const p = el.props ?? {};
  switch (el.type) {
    case "Karte":
    case "Abschnitt":
      return [s(p.titel), s(p.untertitel)].filter(Boolean);
    case "Text":
    case "Hinweis":
      return [s(p.inhalt ?? p.text)].filter(Boolean);
    case "Kennzahl": {
      const d = typeof p.veraenderung === "number" ? ` (${p.veraenderung > 0 ? "+" : ""}${s(p.veraenderung)} %${p.vergleich ? ` ${s(p.vergleich)}` : ""})` : "";
      return [`${s(p.label)}: ${s(p.wert)}${d}`];
    }
    case "Balken": {
      const kat = Array.isArray(p.kategorien) ? (p.kategorien as unknown[]).map(s) : [];
      const reihen = Array.isArray(p.reihen) ? (p.reihen as Array<{ name?: string; werte?: unknown[] }>) : [];
      return [s(p.titel), ...reihen.map((r) => `${s(r.name)}: ${kat.map((k, i) => `${k} ${s(r.werte?.[i])}`).join(", ")}`)].filter(Boolean);
    }
    case "Verlauf": {
      const reihen = Array.isArray(p.reihen) ? (p.reihen as Array<{ name?: string; punkte?: Array<{ x?: unknown; y?: unknown }> }>) : [];
      return [s(p.titel), ...reihen.map((r) => `${s(r.name)}: ${(r.punkte ?? []).map((pt) => `${s(pt.x)} ${s(pt.y)}`).join(", ")}`)].filter(Boolean);
    }
    case "Rangliste": {
      const e = Array.isArray(p.eintraege) ? (p.eintraege as Array<{ label?: string; wert?: unknown }>) : [];
      return [s(p.titel), ...e.map((x, i) => `${i + 1}. ${s(x.label)}: ${s(x.wert)}`)].filter(Boolean);
    }
    case "Ring": {
      const a = Array.isArray(p.anteile) ? (p.anteile as Array<{ label?: string; wert?: unknown }>) : [];
      return [s(p.titel), ...a.map((x) => `• ${s(x.label)}: ${s(x.wert)}`)].filter(Boolean);
    }
    case "Tabelle": {
      const sp = Array.isArray(p.spalten) ? (p.spalten as Array<{ titel?: string }>).map((x) => s(x.titel)) : [];
      const z = Array.isArray(p.zeilen) ? (p.zeilen as unknown[][]) : [];
      const zelle = (c: unknown) => (c && typeof c === "object" && "text" in c ? s((c as { text: unknown }).text) : s(c));
      return [s(p.titel), sp.join(" · "), ...z.slice(0, 20).map((r) => (Array.isArray(r) ? r.map(zelle).join(" · ") : ""))].filter(Boolean);
    }
    case "Firmenkarte":
      return [`Firma ${s(p.companyId)}${p.grund ? `: ${s(p.grund)}` : ""}`];
    case "Marke":
      return [s(p.text)].filter(Boolean);
    default:
      return [];
  }
}

export function specAlsText(raw: string): string {
  const { root, elemente } = elementeAus(raw);
  if (!root || !elemente[root]) return "";
  const out: string[] = [];
  const gesehen = new Set<string>();
  const lauf = (id: string) => {
    if (gesehen.has(id) || !elemente[id]) return;
    gesehen.add(id);
    const el = elemente[id]!;
    out.push(...zeilenFuer(el));
    for (const k of el.children ?? []) lauf(k);
  };
  lauf(root);
  return out.join("\n");
}

/** Ersetzt alle ```spec-Zaeune eines Textes durch ihre Textfassung. */
export function specZaeuneAlsText(text: string): string {
  return text.replace(SPEC_ZAUN_RE, (_, raw: string) => specAlsText(raw));
}
