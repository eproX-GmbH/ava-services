// Website-Themen (docs/PLAN_THEMEN.md, T1): Suchbegriffe und Synonyme zu einem
// Thema ergaenzen lassen — ein kleiner Aufruf ueber den Hintergrundkanal.

import * as yup from "yup";
import type { LlmProviderManager } from "../agent/providers";
import { buildMessages, parseJsonObject, streamToText } from "../link-monitor/llm";
import type { Thema } from "../../shared/themen-types";

const schema = yup.object({ begriffe: yup.array().of(yup.string().trim().min(2).max(60).required()).required() });

export async function begriffeVorschlagen(providers: LlmProviderManager, thema: Pick<Thema, "name" | "beschreibung" | "warum" | "begriffe">): Promise<string[]> {
  const system =
    "Du ergaenzt Suchbegriffe, mit denen eine Firmen-Website nach einem Thema durchsucht wird (Volltextsuche, Gross-/Kleinschreibung egal). " +
    "Liefere 8 bis 15 Begriffe: Synonyme, Wortstaemme, uebliche Schreibweisen, englische Entsprechungen, typische Abkuerzungen. " +
    "Nur Woerter oder kurze Wortgruppen, die wirklich auf einer Website stehen koennten. Keine Saetze, keine Dubletten der vorhandenen Begriffe.\n" +
    'Antworte NUR als JSON: {"begriffe":["..."]}';
  const user = [
    `Thema: ${thema.name}`,
    thema.beschreibung ? `Beschreibung: ${thema.beschreibung}` : "",
    thema.warum ? `Wozu: ${thema.warum}` : "",
    thema.begriffe.length ? `Vorhandene Begriffe: ${thema.begriffe.map((b) => b.text).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const raw = await streamToText(providers, buildMessages(system, user, "themen"), {
    timeoutMs: 40_000,
    channel: "background",
    quelle: "themen",
    ...(providers.getProducerModelOverride() ? { modelOverride: providers.getProducerModelOverride() } : {}),
  });
  const parsed = parseJsonObject(raw);
  if (!parsed) throw new Error("Antwort ohne JSON");
  const valid = schema.validateSync(parsed, { abortEarly: true, stripUnknown: true });
  const vorhanden = new Set(thema.begriffe.map((b) => b.text.toLowerCase()));
  return [...new Set(valid.begriffe.map((b) => b.trim()))].filter((b) => !vorhanden.has(b.toLowerCase())).slice(0, 20);
}
