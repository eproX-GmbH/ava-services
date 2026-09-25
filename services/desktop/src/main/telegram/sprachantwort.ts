// Telegram: Antwort als Sprachnachricht (docs/PLAN_TELEGRAM_SPRACHANTWORT.md).
//
// Der Nutzer steuert in der Nachricht selbst, wie AVA ueber diesen Kanal
// antwortet. Vier Anweisungen, tolerant erkannt:
//   "gerne per Textnachricht"           → diese eine Antwort als Text
//   "gerne immer per Textnachricht"     → Standard = Text
//   "gerne per Sprachnachricht"         → diese eine Antwort gesprochen
//   "gerne immer per Sprachnachricht"   → Standard = Sprachnachricht
// Die Anweisung wird aus dem Text entfernt, bevor er an den Agenten geht.
//
// Erkennung in zwei Stufen: klare Formulierungen trifft ein Muster sofort
// (kein Modellaufruf); alles andere beurteilt das Modell des Nutzers
// (`antwortSteuerungErmitteln`), damit auch "sag's mir lieber muendlich"
// oder "ich kann gerade nicht lesen" verstanden werden. Ohne Modell oder
// bei Fehler gilt: keine Anweisung.
//
// Die Stimme kommt von OpenAI (gpt-4o-mini-tts, Stimme "marin" wie im
// Sprachmodus, Ausgabe Opus → Telegram-Sprachnachricht). Schluessel wie im
// Chat: eigener zuerst, Organisation ueber den Gateway-Proxy als Rueckfall.

export type AntwortModus = "text" | "sprache";

export interface AntwortSteuerung {
  /** Gewuenschter Modus fuer DIESE Antwort; null = nichts gesagt. */
  modus: AntwortModus | null;
  /** "immer"/"ab jetzt": Standard umstellen. */
  dauerhaft: boolean;
  /** Nachricht ohne die Anweisung. */
  bereinigt: string;
}

const DAUER = "(?:ab\\s+jetzt|ab\\s+sofort|immer|k(?:ü|ue)nftig|zuk(?:ü|ue)nftig|in\\s+zukunft|von\\s+nun\\s+an)";
const SPRACHE = "(?:sprachnachricht(?:en)?|sprachmemo|sprach-?antwort|audio(?:nachricht)?|voice(?:\\s*message)?|gesprochen)";
const TEXT = "(?:textnachricht(?:en)?|text|schriftlich|geschrieben)";
const RE = new RegExp(
  `[,;.!\\s]*(?:\\(|-\\s*)?(?:bitte\\s+|gerne\\s+|gern\\s+)?(?:antworte\\s+|antwort\\s+|antworten\\s+)?(?:${DAUER}\\s+)*(?:bitte\\s+|gerne\\s+|gern\\s+)?(?:(?:nur\\s+)?(?:per|als|mit|in)\\s+(?:einer\\s+|eine\\s+)?)?(?:${DAUER}\\s+)*(${SPRACHE}|${TEXT})(?:\\s+(?:antworten|bitte|antwort|zur(?:ü|ue)ck))?(?:\\s+${DAUER})?\\)?[.!\\s]*$`,
  "i",
);
const NUR_ANWEISUNG = new RegExp(
  `^\\s*(?:bitte\\s+|gerne\\s+|gern\\s+)?(?:antworte\\s+|antwort\\s+|antworten\\s+)?(?:${DAUER}\\s+)*(?:bitte\\s+|gerne\\s+|gern\\s+)?(?:(?:nur\\s+)?(?:per|als|mit|in)\\s+(?:einer\\s+|eine\\s+)?)?(?:${DAUER}\\s+)*(${SPRACHE}|${TEXT})(?:\\s+(?:antworten|bitte|antwort))?(?:\\s+${DAUER})?[.!\\s]*$`,
  "i",
);

export function parseAntwortSteuerung(text: string): AntwortSteuerung {
  const roh = text ?? "";
  const m = NUR_ANWEISUNG.exec(roh) ?? RE.exec(roh);
  if (!m) return { modus: null, dauerhaft: false, bereinigt: roh.trim() };
  const treffer = m[0];
  const wort = (m[1] ?? "").toLowerCase();
  const modus: AntwortModus = new RegExp(`^${SPRACHE}$`, "i").test(wort) ? "sprache" : "text";
  const dauerhaft = new RegExp(DAUER, "i").test(treffer);
  const bereinigt = (roh.slice(0, m.index) + roh.slice(m.index + treffer.length)).replace(/\s+/g, " ").replace(/[\s,;]+$/g, "").trim();
  return { modus, dauerhaft, bereinigt };
}

/** Hoechstlaenge fuer die Stimme (OpenAI: 4096 Zeichen). */
const TTS_MAX = 3800;
export const TTS_MODELL = "gpt-4o-mini-tts";
export const TTS_STIMME = "marin";

/** Text in eine Sprachnachricht (OGG/Opus) wandeln. Wirft bei Fehlern. */
export async function sprachantwortErzeugen(text: string, zugang: { apiKey: string; baseURL: string }): Promise<Buffer> {
  const input = text.replace(/\s+/g, " ").trim().slice(0, TTS_MAX);
  if (!input) throw new Error("leerer Text");
  const res = await fetch(`${zugang.baseURL.replace(/\/+$/, "")}/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${zugang.apiKey}`, "x-ava-llm-channel": "chat" },
    body: JSON.stringify({
      model: TTS_MODELL,
      voice: TTS_STIMME,
      input,
      response_format: "opus",
      instructions: "Sprich Deutsch, klar und direkt, freundlich, in normalem Tempo. Keine Fuellwoerter. Zahlen natuerlich aussprechen.",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Sprachausgabe fehlgeschlagen (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

import * as yup from "yup";
import type { LlmProviderManager } from "../agent/providers/manager";

const UrteilSchema = yup
  .object({
    modus: yup.string().oneOf(["text", "sprache"]).nullable().defined(),
    dauerhaft: yup.boolean().required(),
    auftrag: yup.string().defined(),
  })
  .noUnknown(true);

function jsonObjekt(text: string): unknown {
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const roh = (m ? m[1]! : text).trim();
  try { return JSON.parse(roh); } catch { /* weiter */ }
  const a = roh.indexOf("{"), b = roh.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(roh.slice(a, b + 1)); } catch { return null; }
}

/**
 * Anweisung zur Antwortform ermitteln: erst das Muster, sonst das Modell.
 * Liefert immer ein Ergebnis; bei Unsicherheit "keine Anweisung".
 */
export async function antwortSteuerungErmitteln(text: string, providers: LlmProviderManager | null | undefined): Promise<AntwortSteuerung> {
  const schnell = parseAntwortSteuerung(text);
  if (schnell.modus) return schnell;
  if (!providers || !text.trim()) return schnell;
  const prompt = [
    "Du prueft eine Telegram-Nachricht eines Nutzers an seine Assistentin AVA. Frage: Sagt der Nutzer, in welcher FORM AVA antworten soll — als Textnachricht oder als Sprachnachricht (gesprochen, Audio, muendlich, vorgelesen)? Und gilt das nur fuer diese Antwort oder ab jetzt immer (dauerhaft, Standard umstellen)?",
    "Antworte NUR mit JSON: {\"modus\": \"text\" | \"sprache\" | null, \"dauerhaft\": true | false, \"auftrag\": \"<die Nachricht OHNE die Anweisung zur Antwortform, sonst unveraendert>\"}",
    "modus null, wenn nichts ueber die Antwortform gesagt wird. Beispiele: \"kannst du mir das kurz vorlesen?\" → sprache, einmal. \"ich kann gerade nicht lesen, bin im Auto\" → sprache, einmal. \"schreib mir ab jetzt bitte wieder\" → text, dauerhaft. \"Umsatz von X?\" → null.",
    "Nachricht:",
    text.slice(0, 2000),
  ].join("\n");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  let antwort = "";
  try {
    // Das guenstige Hintergrund-Modell reicht fuer dieses Urteil; ohne
    // Vorgabe das Chat-Modell.
    const modelOverride = providers.getProducerModelOverride();
    const stream = providers.streamChat({
      messages: [{ id: "steuerung", role: "user", content: prompt, createdAt: Date.now() }],
      signal: ctrl.signal,
      ...(modelOverride ? { modelOverride } : {}),
    });
    for await (const frame of stream) {
      if (frame.contentDelta) antwort += frame.contentDelta;
      if (frame.errorMessage) throw new Error(frame.errorMessage);
      if (frame.done) break;
    }
  } catch (err) {
    console.warn("[telegram] Antwortform-Urteil fehlgeschlagen:", err instanceof Error ? err.message : String(err));
    return schnell;
  } finally {
    clearTimeout(timer);
  }
  const roh = jsonObjekt(antwort);
  if (!roh) return schnell;
  try {
    const u = UrteilSchema.validateSync(roh, { strict: true });
    if (u.modus !== "text" && u.modus !== "sprache") return schnell;
    return { modus: u.modus, dauerhaft: u.dauerhaft === true, bereinigt: (u.auftrag ?? "").trim() };
  } catch {
    return schnell;
  }
}
