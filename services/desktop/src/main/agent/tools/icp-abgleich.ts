// icp_bestand_abgleich (docs/PLAN_BEWERTUNG_ABKLEMMEN.md, 2026-10-12):
// "Welche Firma aus meinem Bestand passt am besten zu meinem ICP?" in EINEM
// synchronen Aufruf. Ersatz fuer den abgeklemmten Bewertungs-Producer.
//
//   1. Bestand aus Meine Firmen (Matrix, seitenweise).
//   2. Kompakte Felder je Firma vom Gateway (Profil, Gegenstand, Stichworte,
//      Mitarbeiter, Umsatz) — ein Aufruf je 300 Firmen.
//   3. Deterministischer Vorfilter aus den ICP-Feldern (Branchen, Groesse,
//      Ausschluesse, Orte) → die plausibelsten Kandidaten.
//   4. Dasselbe lokale KI-Urteil wie der Radar (icpUrteil) fuer die Top-K.
//   5. Rangliste mit Begruendung und Belegfeldern. Kein Job, kein Polling.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { LlmProviderManager } from "../providers";
import type { IcpStore } from "../icp-store";
import type { Tool } from "../types";
import { icpUrteil } from "../../discovery/matcher";
import { vorfilter, type Felder } from "./icp-abgleich-vorfilter";

const MAX_FIRMEN = 1000;
const SEITE = 200;
const JUDGE_BATCH = 8;

interface MatrixZeile {
  companyId: string;
  name: string;
  location?: string | null;
  country?: string;
  registerStatus?: string;
  insolvencyStatus?: string;
}


interface Kandidat extends MatrixZeile {
  felder: Felder | null;
  vorpunkte: number;
  vorgruende: string[];
}

function firmenText(k: Kandidat): string {
  const f = k.felder;
  const teile = [
    `${k.name}${k.location ? ` (${k.location})` : ""}`,
    f?.gegenstand ? `Gegenstand: ${f.gegenstand}` : "",
    f?.profil ? `Profil: ${f.profil}` : "",
    f?.stichworte.length ? `Stichworte: ${f.stichworte.join(", ")}` : "",
    f?.mitarbeiter != null ? `Mitarbeiter: ${f.mitarbeiter}${f.jahr ? ` (${f.jahr})` : ""}` : "",
    f?.umsatz != null ? `Umsatz: ${Math.round(f.umsatz).toLocaleString("de-DE")} EUR${f.jahr ? ` (${f.jahr})` : ""}` : "",
  ].filter(Boolean);
  return teile.join("\n  ");
}

export function buildIcpAbgleichTools(deps: { gateway: GatewayClient; providers: LlmProviderManager; icp: IcpStore }): Tool[] {
  const abgleich = defineTool({
    name: "icp_bestand_abgleich",
    summary: "Welche Firmen aus Meine Firmen passen am besten zum ICP (oder zu einer Anfrage)? Rangliste mit Begruendung in einem Aufruf.",
    category: "icp idealkunden bestand best match angebot",
    description:
      "Gleicht den eigenen Bestand (Meine Firmen) mit dem Idealkundenprofil ab und liefert SOFORT eine Rangliste: " +
      "Vorfilter aus Branchen, Groesse, Ausschluessen und Orten des ICP, danach ein lokales KI-Urteil (0-100 + ein Satz) " +
      "fuer die plausibelsten Firmen — dieselbe Bewertung wie im Radar. Mit `anfrage` (Angebot, Ausschreibung, Freitext) " +
      "wird zusaetzlich gegen diesen Text bewertet. Synchron, wenige Sekunden bis eine Minute; kein Job, kein Nachfragen. " +
      "Antworte dem Nutzer mit der Rangliste (Firmenname als [Name](company:id), Score, Begruendung) und nenne, wie viele Firmen geprueft wurden.",
    parameters: {
      type: "object",
      properties: {
        anfrage: { type: "string", description: "Optional: Angebot/Anfrage/Ausschreibung als Freitext, gegen den zusaetzlich bewertet wird." },
        top: { type: "integer", minimum: 3, maximum: 30, description: "Wie viele Firmen das KI-Urteil bekommen (Standard 15)." },
        suche: { type: "string", description: "Optional: Bestand auf Firmen mit diesem Namensteil/Ort einschraenken." },
      },
    },
    schema: yup.object({
      anfrage: yup.string().trim().max(4000).optional(),
      top: yup.number().integer().min(3).max(30).default(15),
      suche: yup.string().trim().max(200).optional(),
    }),
    preview: (r) => {
      const x = r as { rangliste?: unknown[]; geprueft?: number; error?: string };
      return x.error ? `Fehler: ${x.error.slice(0, 60)}` : `${x.rangliste?.length ?? 0} bewertet von ${x.geprueft ?? 0} Firmen`;
    },
    run: async (args, c) => {
      const icp = deps.icp.get();
      if (!deps.icp.isSet() && !args.anfrage) {
        return { error: "Kein ICP hinterlegt und keine Anfrage angegeben. Erst das Idealkundenprofil festlegen (icp_set) oder eine Anfrage mitgeben." };
      }
      const hinweise: string[] = [];
      // 1. Bestand.
      const zeilen: MatrixZeile[] = [];
      for (let seite = 1; zeilen.length < MAX_FIRMEN; seite++) {
        const m = await deps.gateway.request<{ count: number; companies: MatrixZeile[] }>("/v1/companies/matrix", {
          query: { pageNumber: seite, pageSize: SEITE, ...(args.suche ? { search: args.suche } : {}) },
          signal: c.signal,
        });
        zeilen.push(...(m.companies ?? []));
        if ((m.companies ?? []).length < SEITE) break;
      }
      if (zeilen.length === 0) return { geprueft: 0, rangliste: [], hinweise: ["Keine Firmen in Meine Firmen — zuerst Firmen aufbereiten (import_companies)."] };
      if (zeilen.length >= MAX_FIRMEN) hinweise.push(`Nur die ersten ${MAX_FIRMEN} Firmen des Bestands beruecksichtigt; mit \`suche\` eingrenzen.`);
      // 2. Felder in Bloecken.
      const felder = new Map<string, Felder>();
      for (let i = 0; i < zeilen.length; i += 300) {
        const block = zeilen.slice(i, i + 300).map((z) => z.companyId);
        try {
          const r = await deps.gateway.request<{ items: Felder[] }>("/v1/companies/icp-felder", { method: "POST", body: { companyIds: block }, signal: c.signal });
          for (const f of r.items) felder.set(f.companyId, f);
        } catch (err) {
          hinweise.push(`Felder fuer ${block.length} Firmen nicht ladbar: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // 3. Vorfilter.
      const kandidaten: Kandidat[] = zeilen.map((z) => {
        const f = felder.get(z.companyId) ?? null;
        const v = vorfilter(icp, { location: z.location, felder: f });
        if (z.registerStatus && z.registerStatus !== "ACTIVE") { v.punkte -= 5; v.gruende.push("Registerblatt geschlossen"); }
        if (z.insolvencyStatus && z.insolvencyStatus !== "NONE") { v.punkte -= 3; v.gruende.push(`Insolvenz: ${z.insolvencyStatus}`); }
        return { ...z, felder: f, vorpunkte: v.punkte, vorgruende: v.gruende };
      });
      const ohneProfil = kandidaten.filter((k) => !k.felder || (!k.felder.profil && !k.felder.gegenstand)).length;
      if (ohneProfil > 0) hinweise.push(`${ohneProfil} von ${kandidaten.length} Firmen ohne Profil (Stufe Profil nicht gelaufen) — nur schwach bewertbar.`);
      kandidaten.sort((a, b) => b.vorpunkte - a.vorpunkte || a.name.localeCompare(b.name));
      const topK = kandidaten.slice(0, args.top);
      // 4. KI-Urteil (lokal), dieselbe Funktion wie der Radar.
      const kriterien = [deps.icp.isSet() ? deps.icp.renderText() : "", args.anfrage ? `Konkrete Anfrage des Nutzers (hat Vorrang vor allgemeinen ICP-Angaben):\n${args.anfrage}` : ""].filter(Boolean).join("\n\n");
      const urteile = new Map<string, { score: number; begruendung: string }>();
      for (let i = 0; i < topK.length; i += JUDGE_BATCH) {
        if (c.signal?.aborted) break;
        const charge = topK.slice(i, i + JUDGE_BATCH);
        const part = await icpUrteil(deps.providers, kriterien, charge.map((k) => ({ id: k.companyId, text: firmenText(k), hinweis: k.vorgruende.length ? `Vorfilter: ${k.vorgruende.join("; ")}` : undefined })));
        for (const [k, v] of part) urteile.set(k, v);
      }
      if (urteile.size === 0 && topK.length > 0) {
        return { error: "KI-Urteil fehlgeschlagen (kein Modell bereit oder unparsbare Antwort). Vorauswahl ohne Score:", geprueft: kandidaten.length, vorauswahl: topK.map((k) => ({ companyId: k.companyId, name: k.name, ort: k.location ?? null, vorfilter: k.vorgruende })), hinweise };
      }
      // 5. Rangliste.
      const rangliste = topK
        .map((k) => {
          const u = urteile.get(k.companyId);
          return {
            companyId: k.companyId,
            name: k.name,
            ort: k.location ?? null,
            score: u?.score ?? null,
            begruendung: u?.begruendung ?? "kein Urteil erhalten",
            belege: {
              mitarbeiter: k.felder?.mitarbeiter ?? null,
              umsatz: k.felder?.umsatz ?? null,
              jahr: k.felder?.jahr ?? null,
              vorfilter: k.vorgruende,
            },
          };
        })
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
      return {
        geprueft: kandidaten.length,
        bewertet: rangliste.filter((r) => r.score != null).length,
        kriterien: args.anfrage ? "ICP + Anfrage" : "ICP",
        rangliste,
        hinweise,
      };
    },
  });
  return [abgleich];
}
