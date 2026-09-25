// Sprachmodus (docs/PLAN_SPRACHMODUS.md): Vollbild ueber der App, weiss,
// Sprachkugel, unten Eingabe/Mikrofon/X. Die Sprach-KI ist die Stimme; alles
// mit Werkzeugen laeuft ueber `ava_bearbeiten` in den Chat-Orchestrator
// (Relay im Hauptprozess). Verlassen nur ueber das X (oder Esc). Keine
// Navigation, keine Links: Klicks auf Anker in Bloecken werden abgefangen.
//
// Ruhezustand: nach `ruheSekunden` Stille ohne laufenden Auftrag wird die
// Verbindung geschlossen (keine Kosten); die letzten 8 Sekunden zeigt die
// Kugel einen Ring. Wecken per "Hey AVA" (lokal ueber Whisper), Klick auf
// die Kugel, Leertaste oder Tippen. Der Gespraechsfaden bleibt: Die neue
// Sitzung bekommt die letzten Zuege als Kontext.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import type { SpracheBlock, SpracheErgebnis, SpracheFortschritt, SpracheRueckfrage, SpracheSitzung, SpracheStand } from "../../../shared/types";
import { LaufStatus, VerbrauchZeile } from "../components/Verbrauch";
import { RealtimeVerbindung, signalton, fehlerEinordnen, type RealtimeEreignis, type SpracheFehlerArt } from "../lib/realtime";
import { LiveVerbindung, inHappen } from "../lib/live";
import { WachwortLauscher, PufferAufnahme } from "../lib/wachwort";
import { composePromptWithAttachments, isSupportedAttachment, parseAttachment, ScanPdfDetectedError, type SpreadsheetAttachment } from "../lib/attachment";
import { SprachKugel, type KugelZustand } from "../components/SprachKugel";
import { ChartBlock } from "../components/ChartBlock";
import { BuyingCenterBlock } from "../components/BuyingCenterBlock";

type Phase = "start" | "verbindet" | "wach" | "ruhe" | "fehler";
interface Zeile { wer: "ava" | "du" | "system"; text: string; t: number }
interface BlockAnzeige extends SpracheBlock { gepinnt: boolean; seit: number }

const COUNTDOWN_AB = 8;
const KONTEXT_ZEILEN = 10;
/** OpenAI beendet Realtime-Sitzungen nach 60 Minuten; vorher still neu verbinden. */
const NEUVERBINDUNG_MS = 55 * 60 * 1000;

/** Token-Zahlen aus response.done.usage in die Meldung ans Gateway uebersetzen. */
export function verbrauchAus(usage: Record<string, unknown> | undefined): Record<string, number> | null {
  if (!usage) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  const inD = (usage["input_token_details"] ?? {}) as Record<string, unknown>;
  const outD = (usage["output_token_details"] ?? {}) as Record<string, unknown>;
  const cached = (inD["cached_tokens_details"] ?? {}) as Record<string, unknown>;
  return {
    inputTokens: n(usage["input_tokens"]), outputTokens: n(usage["output_tokens"]),
    inputTextTokens: n(inD["text_tokens"]), inputAudioTokens: n(inD["audio_tokens"]),
    outputTextTokens: n(outD["text_tokens"]), outputAudioTokens: n(outD["audio_tokens"]),
    cachedTextTokens: n(cached["text_tokens"]), cachedAudioTokens: n(cached["audio_tokens"]),
  };
}

function bildAusDatei(file: File): Promise<import("../../../shared/types").AgentMessageImage> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("Datei nicht lesbar"));
    r.onload = () => {
      const url = String(r.result ?? "");
      const i = url.indexOf(",");
      resolve({ base64: i >= 0 ? url.slice(i + 1) : url, mimeType: file.type || "image/png", filename: file.name });
    };
    r.readAsDataURL(file);
  });
}

function neueId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function Sprachmodus() {
  const navigate = useNavigate();
  const [stand, setStand] = useState<SpracheStand | null>(null);
  const [phase, setPhase] = useState<Phase>("start");
  const [fehler, setFehler] = useState<string | null>(null);
  const [fehlerArt, setFehlerArt] = useState<SpracheFehlerArt | null>(null);
  const [fehlerDetail, setFehlerDetail] = useState<string | null>(null);
  const [sichtbar, setSichtbar] = useState(false);
  const [aiSpricht, setAiSpricht] = useState(false);
  const [nutzerSpricht, setNutzerSpricht] = useState(false);
  const [antwortet, setAntwortet] = useState(false);
  const [auftragLaeuft, setAuftragLaeuft] = useState(false);
  const [stumm, setStumm] = useState(false);
  const [pegel, setPegel] = useState(0);
  const [eingang, setEingang] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [bloecke, setBloecke] = useState<BlockAnzeige[]>([]);
  const [rueckfrage, setRueckfrage] = useState<SpracheRueckfrage | null>(null);
  const [transkript, setTranskript] = useState<Zeile[]>([]);
  const [laufendeZeile, setLaufendeZeile] = useState("");
  const [eingabe, setEingabe] = useState("");
  // Fortschritt des laufenden Auftrags: Werkzeuge und Verbrauch (wie Claude Code).
  const [fortschritt, setFortschritt] = useState<SpracheFortschritt | null>(null);
  const [auftragStart, setAuftragStart] = useState<number | null>(null);
  const [schritteOffen, setSchritteOffen] = useState(false);

  const conversationId = useMemo(() => neueId(), []);
  const verbindung = useRef<RealtimeVerbindung | LiveVerbindung | null>(null);
  // GPT Live ist der Standard (Delegation an den Relay, Abrechnung je
  // Sekunde); die Realtime API bleibt Rueckfall, wenn Live nicht angelegt
  // werden kann. Beide Wege teilen Kugel, Bloecke und Relay.
  const protoRef = useRef<"live" | "realtime">("live");
  const delegationRef = useRef<string | null>(null);
  const nutzerTranskript = useRef("");
  const rueckfrageRef = useRef<SpracheRueckfrage | null>(null);
  const sprichtTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveSekunden = useRef({ gesamt: 0, gemeldet: 0 });
  const lauscher = useRef<WachwortLauscher | null>(null);
  const letzteAktivitaet = useRef(Date.now());
  const sitzungSeit = useRef(Date.now());
  const modellRef = useRef("gpt-realtime-2.1");
  const antwortSeit = useRef(0);
  const zustandRef = useRef({ phase, aiSpricht, auftragLaeuft, antwortet, stumm });
  zustandRef.current = { phase, aiSpricht, auftragLaeuft, antwortet, stumm };
  const bloeckeRef = useRef(bloecke);
  bloeckeRef.current = bloecke;
  const transkriptRef = useRef(transkript);
  transkriptRef.current = transkript;

  const aktiv = () => { letzteAktivitaet.current = Date.now(); };
  const logge = useCallback((wer: Zeile["wer"], text: string) => {
    if (!text.trim()) return;
    setTranskript((t) => [...t.slice(-60), { wer, text: text.trim(), t: Date.now() }]);
  }, []);

  // ---- Bloecke: "Bildschirm folgt dem Gespraech" ---------------------------
  const bildschirmListe = (liste: BlockAnzeige[]) => liste.length ? liste.map((b) => `${b.id}: ${b.titel}${b.bezug ? ` (${b.bezug})` : ""}`).join("; ") : "nichts";
  const bloeckeAufnehmen = useCallback((neu: SpracheBlock[]) => {
    if (neu.length === 0) return;
    setBloecke((alt) => {
      const bezugNeu = new Set(neu.map((b) => b.bezug).filter((b): b is string => !!b));
      let rest = alt;
      if (bezugNeu.size > 0) rest = alt.filter((b) => b.gepinnt || !b.bezug || bezugNeu.has(b.bezug));
      rest = rest.filter((b) => b.gepinnt || !neu.some((n) => n.art === b.art && n.bezug === b.bezug && b.bezug !== null));
      return [...rest, ...neu.map((b) => ({ ...b, gepinnt: false, seit: Date.now() }))];
    });
  }, []);

  // ---- Realtime-Ereignisse -------------------------------------------------
  const senden = (e: RealtimeEreignis) => verbindung.current?.senden(e);
  /**
   * Text an die Sprach-KI geben. Live: Commentary (soll gesprochen werden)
   * oder Thinking (nur Kontext), jeweils in Happen von ≈ 500 Token und mit
   * der laufenden Delegation verknuepft. Realtime: als Nutzer-Nachricht
   * plus response.create.
   */
  const nachrichtEinlegen = (text: string, antworten = true) => {
    if (protoRef.current === "live") {
      const art = antworten ? "commentary" : "thinking";
      for (const h of inHappen(text)) senden({ type: `session.${art}.append`, delegation_id: delegationRef.current, content: h });
      return;
    }
    senden({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    if (antworten) senden({ type: "response.create" });
  };
  const liveVerbrauchMelden = () => {
    const delta = liveSekunden.current.gesamt - liveSekunden.current.gemeldet;
    if (delta <= 0) return;
    liveSekunden.current.gemeldet = liveSekunden.current.gesamt;
    void window.api.sprache.verbrauch({ model: modellRef.current, usage: { inputTokens: 0, outputTokens: 0 }, sekunden: delta });
  };
  const werkzeugErgebnis = (callId: string, output: unknown, antworten = true) => {
    senden({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
    if (antworten) senden({ type: "response.create" });
  };

  const werkzeug = useCallback(async (name: string, argsRoh: string, callId: string) => {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsRoh || "{}") as Record<string, unknown>; } catch { /* leer */ }
    aktiv();
    if (name === "ava_bearbeiten") {
      const text = String(args["auftrag"] ?? "").trim();
      if (!text) { werkzeugErgebnis(callId, { error: "leerer Auftrag" }); return; }
      logge("du", text);
      const r = await window.api.sprache.auftrag({ conversationId, text });
      if (r.laeuft) { setAuftragLaeuft(true); werkzeugErgebnis(callId, { status: "laeuft", hinweis: "Sag einen kurzen Satz und warte auf 'ERGEBNIS von AVA'." }); }
      else werkzeugErgebnis(callId, { error: r.grund ?? "nicht gestartet" });
      return;
    }
    if (name === "ava_rueckfrage_beantworten") {
      const r = await window.api.sprache.rueckfrage(String(args["choiceId"] ?? ""), String(args["wert"] ?? ""));
      if (r.ok) { setRueckfrage(null); rueckfrageRef.current = null; setAuftragLaeuft(true); }
      werkzeugErgebnis(callId, r.ok ? { status: "weitergegeben", hinweis: "AVA arbeitet weiter; warte auf 'ERGEBNIS von AVA'." } : { error: r.grund ?? "nicht angenommen" });
      return;
    }
    if (name === "ava_anzeigen") {
      const entfernen = new Set((args["entfernen"] as string[] | undefined) ?? []);
      const alle = args["alle_entfernen"] === true;
      setBloecke((alt) => alt.filter((b) => b.gepinnt || (!alle && !entfernen.has(b.id))));
      const nachher = bloeckeRef.current.filter((b) => b.gepinnt || (!alle && !entfernen.has(b.id)));
      werkzeugErgebnis(callId, { aufDemBildschirm: bildschirmListe(nachher) }, false);
      return;
    }
    werkzeugErgebnis(callId, { error: `unbekanntes Werkzeug ${name}` });
  }, [conversationId, logge]);

  const ereignis = useCallback((e: RealtimeEreignis) => {
    switch (e.type) {
      // ---- GPT Live --------------------------------------------------------
      case "session.started": setPhase("wach"); aktiv(); return;
      case "session.input_transcript.delta": {
        nutzerTranskript.current += String(e["delta"] ?? "");
        setNutzerSpricht(true); aktiv();
        if (hoertTimer.current) clearTimeout(hoertTimer.current);
        hoertTimer.current = setTimeout(() => setNutzerSpricht(false), 900);
        return;
      }
      case "session.output_transcript.delta": {
        setLaufendeZeile((z) => z + String(e["delta"] ?? ""));
        setAiSpricht(true); aktiv();
        if (sprichtTimer.current) clearTimeout(sprichtTimer.current);
        sprichtTimer.current = setTimeout(() => {
          setAiSpricht(false);
          setLaufendeZeile((z) => { if (z.trim()) logge("ava", z); return ""; });
        }, 1400);
        return;
      }
      case "session.delegation.created": {
        // Die Delegation traegt den Auftrag nicht; er steht im Gesagten seit
        // der letzten Delegation. Offene Rueckfrage: das Gesagte ist die Antwort.
        const d = (e["delegation"] as { id?: string } | undefined)?.id ?? null;
        delegationRef.current = d;
        const gesagt = nutzerTranskript.current.replace(/\s+/g, " ").trim();
        nutzerTranskript.current = "";
        aktiv();
        if (!gesagt) { senden({ type: "session.thinking.append", delegation_id: d, content: "Kein verstaendlicher Auftrag; bitte den Nutzer, es noch einmal zu sagen." }); return; }
        const rf = rueckfrageRef.current;
        if (rf) {
          void window.api.sprache.rueckfrage(rf.choiceId, gesagt).then((r) => {
            if (r.ok) { setRueckfrage(null); rueckfrageRef.current = null; setAuftragLaeuft(true); senden({ type: "session.thinking.append", delegation_id: d, content: "Antwort an AVA weitergegeben; AVA arbeitet weiter. Ergebnis folgt." }); }
            else senden({ type: "session.commentary.append", delegation_id: d, content: `Die Antwort konnte nicht weitergegeben werden: ${r.grund ?? "unbekannt"}.` });
          });
          return;
        }
        logge("du", gesagt);
        void window.api.sprache.auftrag({ conversationId, text: gesagt }).then((r) => {
          if (r.laeuft) { setAuftragLaeuft(true); senden({ type: "session.thinking.append", delegation_id: d, content: `Auftrag angenommen: "${gesagt.slice(0, 200)}". AVA arbeitet; sag einen kurzen Satz und warte auf das Ergebnis.` }); }
          else senden({ type: "session.commentary.append", delegation_id: d, content: `Das ging gerade nicht: ${r.grund ?? "Auftrag nicht gestartet"}.` });
        });
        return;
      }
      case "session.usage.updated": {
        const sek = (e["usage"] as { seconds?: number } | undefined)?.seconds;
        if (typeof sek === "number") liveSekunden.current.gesamt = sek;
        return;
      }
      case "session.closed": {
        const sek = (e["usage"] as { seconds?: number } | undefined)?.seconds;
        if (typeof sek === "number") liveSekunden.current.gesamt = sek;
        liveVerbrauchMelden();
        const grund = String(e["reason"] ?? "");
        if ((grund === "expired" || grund === "connection_lost") && zustandRef.current.phase === "wach") {
          verbindung.current?.schliessen(); verbindung.current = null;
          void verbindenRef.current?.(true);
        }
        return;
      }
      // ---- Realtime API (Rueckfall) --------------------------------------
      case "input_audio_buffer.speech_started": setNutzerSpricht(true); aktiv(); return;
      case "input_audio_buffer.speech_stopped": setNutzerSpricht(false); aktiv(); return;
      case "response.created": setAntwortet(true); antwortSeit.current = Date.now(); aktiv(); return;
      case "output_audio_buffer.started": setAiSpricht(true); aktiv(); return;
      case "output_audio_buffer.stopped": case "output_audio_buffer.cleared": setAiSpricht(false); aktiv(); return;
      case "response.output_audio_transcript.delta": setLaufendeZeile((z) => z + String(e["delta"] ?? "")); return;
      case "response.output_audio_transcript.done": {
        const t = String(e["transcript"] ?? "");
        setLaufendeZeile("");
        logge("ava", t);
        return;
      }
      case "response.done": {
        setAntwortet(false);
        const resp = e["response"] as { output?: Array<Record<string, unknown>>; usage?: Record<string, unknown> } | undefined;
        const usage = verbrauchAus(resp?.usage);
        if (usage && (usage.inputTokens || usage.outputTokens)) void window.api.sprache.verbrauch({ model: modellRef.current, latencyMs: antwortSeit.current ? Date.now() - antwortSeit.current : 0, usage });
        const out = (resp?.output ?? []);
        for (const item of out) {
          if (item["type"] === "function_call") void werkzeug(String(item["name"] ?? ""), String(item["arguments"] ?? ""), String(item["call_id"] ?? ""));
        }
        aktiv();
        return;
      }
      case "error": {
        const err = e["error"] as { message?: string } | undefined;
        setFehler(err?.message ?? "Fehler in der Sitzung");
        return;
      }
      default: return;
    }
  }, [logge, werkzeug]);

  useEffect(() => window.api.sprache.onFortschritt((f) => {
    if (f.conversationId !== conversationId) return;
    setFortschritt((alt) => (alt && alt.requestId !== f.requestId ? f : f));
  }), [conversationId]);
  useEffect(() => {
    if (auftragLaeuft) { setAuftragStart((alt) => alt ?? Date.now()); setFortschritt((f) => (f?.fertig ? null : f)); }
    else setAuftragStart(null);
  }, [auftragLaeuft]);

  // ---- Ergebnisse vom Relay ------------------------------------------------
  useEffect(() => window.api.sprache.onErgebnis((erg: SpracheErgebnis) => {
    if (erg.conversationId !== conversationId) return;
    aktiv();
    if (erg.rueckfrage) {
      setRueckfrage(erg.rueckfrage);
      rueckfrageRef.current = erg.rueckfrage;
      const opts = erg.rueckfrage.options?.length ? ` Optionen: ${erg.rueckfrage.options.map((o) => `${o.label} [${o.value}]`).join(", ")}.` : "";
      nachrichtEinlegen(`RÜCKFRAGE von AVA (choiceId ${erg.rueckfrage.choiceId}): ${erg.rueckfrage.prompt}${opts} Stelle die Frage kurz; die Antwort des Nutzers gibst du mit ava_rueckfrage_beantworten weiter.`);
      logge("system", `Rückfrage: ${erg.rueckfrage.prompt}`);
      return;
    }
    if (erg.fertig) {
      setAuftragLaeuft(false);
      rueckfrageRef.current = null;
      bloeckeAufnehmen(erg.bloecke);
      const liste = bildschirmListe([...bloeckeRef.current.filter((b) => b.gepinnt || !erg.bloecke.some((n) => n.bezug && n.bezug !== b.bezug)), ...erg.bloecke.map((b) => ({ ...b, gepinnt: false, seit: 0 }))]);
      if (erg.fehler) { nachrichtEinlegen(`ERGEBNIS von AVA: Fehler: ${erg.fehler}`); logge("system", `Fehler: ${erg.fehler}`); return; }
      const text = erg.text || "Kein Ergebnis.";
      logge("system", text);
      nachrichtEinlegen(`ERGEBNIS von AVA:\n${text.slice(0, 6000)}\n\nAuf dem Bildschirm: ${liste}`);
    }
  }), [conversationId, logge, bloeckeAufnehmen]);

  // ---- Verbindung, Ruhezustand, Wecken -------------------------------------
  const verbindenRef = useRef<((mitKontext: boolean) => Promise<void>) | null>(null);
  const verbinden = useCallback(async (mitKontext: boolean) => {
    setPhase("verbindet"); setFehler(null);
    const callbacks = {
      onEreignis: ereignis,
      onZustand: (z: "verbindet" | "offen" | "geschlossen" | "fehler", d?: string) => {
        if (z === "offen") { setPhase("wach"); aktiv(); }
        if (z === "fehler") { const f = fehlerEinordnen(new Error(d ?? "Verbindung verloren")); setFehler(f.message); setFehlerArt(f.art); setFehlerDetail(f.detail); setPhase("fehler"); }
      },
    };
    sitzungSeit.current = Date.now();
    delegationRef.current = null; nutzerTranskript.current = "";
    // 1) GPT Live (Standard)
    const live = new LiveVerbindung(callbacks);
    verbindung.current = live;
    protoRef.current = "live";
    try {
      await live.verbinden((sdp) => window.api.sprache.liveSitzung(sdp));
      modellRef.current = live.model;
      liveSekunden.current = { gesamt: 0, gemeldet: 0 };
    } catch (err) {
      const f = fehlerEinordnen(err);
      // Nur wenn OpenAI die Live-Sitzung ablehnt (400/404), auf Realtime ausweichen;
      // Mikrofon- oder Netzfehler bleiben Fehler.
      if (!/HTTP 40[04]|Live-Sitzung/.test(f.message)) { setFehler(f.message); setFehlerArt(f.art); setFehlerDetail(f.detail); setPhase("fehler"); return; }
      console.warn("[sprache] GPT Live nicht verfügbar, Rückfall auf Realtime:", f.message);
      // 2) Realtime API (Rueckfall)
      let sitzung: SpracheSitzung;
      try { sitzung = await window.api.sprache.sitzung(); } catch (e2) { const g = fehlerEinordnen(e2); setFehler(g.message); setFehlerArt(g.art); setFehlerDetail(g.detail); setPhase("fehler"); return; }
      const v = new RealtimeVerbindung(callbacks);
      verbindung.current = v;
      protoRef.current = "realtime";
      modellRef.current = sitzung.model;
      try { await v.verbinden(sitzung.clientSecret, sitzung.model); } catch (e3) { const g = fehlerEinordnen(e3); setFehler(g.message); setFehlerArt(g.art); setFehlerDetail(g.detail); setPhase("fehler"); return; }
    }
    setFehlerArt(null); setFehlerDetail(null);
    if (zustandRef.current.stumm) verbindung.current?.mikrofon(false);
    if (mitKontext) {
      const letzte = transkriptRef.current.slice(-KONTEXT_ZEILEN).map((z) => `${z.wer === "ava" ? "AVA" : z.wer === "du" ? "Nutzer" : "System"}: ${z.text}`).join("\n");
      if (letzte) nachrichtEinlegen(`KONTEXT (Gespräch wird nach einer Pause fortgeführt; nicht wiederholen, nur beachten):\n${letzte}\nAuf dem Bildschirm: ${bildschirmListe(bloeckeRef.current)}`, false);
      liveSekunden.current = { gesamt: 0, gemeldet: 0 };
    }
  }, [ereignis]);
  verbindenRef.current = verbinden;

  const schlafen = useCallback(() => {
    const v = verbindung.current; verbindung.current = null;
    if (v instanceof LiveVerbindung) { liveVerbrauchMelden(); void v.beenden(); } else v?.schliessen();
    setPhase("ruhe"); setAiSpricht(false); setNutzerSpricht(false); setAntwortet(false); setCountdown(null);
    if (stand?.einstellungen.wachwort && stand.whisperBereit) {
      const l = new WachwortLauscher(() => { void wecken(); }, async (wav) => (await window.api.voice.transcribe(wav)).text);
      lauscher.current = l;
      l.starten().catch(() => { lauscher.current = null; });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stand]);

  const wecken = useCallback(async () => {
    if (zustandRef.current.phase !== "ruhe") return;
    lauscher.current?.stoppen(); lauscher.current = null;
    if (stand?.einstellungen.signalton !== false) signalton();
    aktiv();
    // S4b — was waehrend des Aufbaus gesagt wird, lokal puffern und danach
    // als Text nachreichen (Whisper), damit der erste Satz nicht verloren geht.
    let puffer: PufferAufnahme | null = null;
    if (stand?.whisperBereit) {
      puffer = new PufferAufnahme();
      await puffer.starten().catch(() => { puffer = null; });
    }
    await verbinden(true);
    const wav = puffer?.stoppen() ?? null;
    if (wav && (zustandRef.current.phase as Phase) === "wach") {
      try {
        const { text } = await window.api.voice.transcribe(wav);
        const t = text.trim();
        if (t.length > 3 && !/^(hey|hallo|hi|he|ey)?[\s,]*(ava|afa|eva)[.!?]*$/i.test(t)) {
          logge("du", t);
          nachrichtEinlegen(`Der Nutzer sagte, während die Verbindung aufgebaut wurde: "${t}"`);
        }
      } catch { /* kein Text */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stand, verbinden]);

  // Alerts/Banner der App bleiben waehrend des Gespraechs verborgen (CSS
  // ueber body.sprachmodus); sie erscheinen wieder beim Verlassen.
  useEffect(() => {
    document.body.classList.add("sprachmodus");
    return () => document.body.classList.remove("sprachmodus");
  }, []);

  useEffect(() => {
    let weg = false;
    void (async () => {
      const s = await window.api.sprache.stand();
      if (weg) return;
      setStand(s);
      requestAnimationFrame(() => setSichtbar(true));
      await verbinden(false);
    })();
    const ab = window.api.sprache.onStandChanged(setStand);
    return () => {
      weg = true; ab();
      const v = verbindung.current; verbindung.current = null;
      if (v instanceof LiveVerbindung) { liveVerbrauchMelden(); void v.beenden(); } else v?.schliessen();
      lauscher.current?.stoppen(); void window.api.sprache.abbrechen();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pegel + Ruhe-Timer
  useEffect(() => {
    const id = setInterval(() => {
      const v = verbindung.current;
      setPegel(v ? v.pegelAusgabe() : 0);
      setEingang(v ? v.pegelEingang() : 0);
      const z = zustandRef.current;
      if (z.phase !== "wach") { setCountdown(null); return; }
      if (z.aiSpricht || z.auftragLaeuft || z.antwortet) { letzteAktivitaet.current = Date.now(); setCountdown(null); return; }
      // 55 Minuten: still neu verbinden, solange niemand spricht; Kontext geht mit.
      if (protoRef.current === "realtime" && Date.now() - sitzungSeit.current > NEUVERBINDUNG_MS) {
        sitzungSeit.current = Date.now();
        verbindung.current?.schliessen(); verbindung.current = null;
        void verbinden(true);
        return;
      }
      const ruhe = stand?.einstellungen.ruheSekunden ?? 20;
      const rest = ruhe - (Date.now() - letzteAktivitaet.current) / 1000;
      setCountdown(rest <= COUNTDOWN_AB ? Math.max(0, Math.ceil(rest)) : null);
      if (rest <= 0) schlafen();
    }, 100);
    return () => clearInterval(id);
  }, [stand, schlafen, verbinden]);

  // Bloecke ohne Erwaehnung nach 10 Minuten ausblenden
  useEffect(() => {
    const id = setInterval(() => setBloecke((alt) => alt.filter((b) => b.gepinnt || Date.now() - b.seit < 10 * 60 * 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  // Tastatur: Esc = X, Leertaste im Ruhezustand = wecken; bei stummem
  // Mikrofon = Push-to-Talk (gedrueckt halten: sprechen, loslassen: senden).
  const pttAktiv = useRef(false);
  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") { ev.preventDefault(); beenden(); return; }
      if (ev.key !== " " || (ev.target as HTMLElement | null)?.tagName === "INPUT") return;
      const z = zustandRef.current;
      if (z.phase === "ruhe") { ev.preventDefault(); void wecken(); return; }
      if (z.phase === "wach" && z.stumm && !pttAktiv.current) {
        ev.preventDefault();
        pttAktiv.current = true;
        verbindung.current?.mikrofon(true);
        if (protoRef.current === "realtime") senden({ type: "input_audio_buffer.clear" });
        setNutzerSpricht(true);
        aktiv();
      }
    };
    const u = (ev: KeyboardEvent) => {
      if (ev.key !== " " || !pttAktiv.current) return;
      pttAktiv.current = false;
      verbindung.current?.mikrofon(false);
      if (protoRef.current === "realtime") { senden({ type: "input_audio_buffer.commit" }); senden({ type: "response.create" }); }
      setNutzerSpricht(false);
      aktiv();
    };
    window.addEventListener("keydown", h);
    window.addEventListener("keyup", u);
    return () => { window.removeEventListener("keydown", h); window.removeEventListener("keyup", u); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wecken]);

  // Anhaenge: Bilder gehen direkt als Auftrag an den Orchestrator (mit dem
  // getippten Text als Frage); die Sprach-KI erfaehrt es und wartet auf das
  // Ergebnis wie bei jedem Auftrag.
  const dateiRef = useRef<HTMLInputElement>(null);
  const anhaengen = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const alle = Array.from(files);
    const bilder = await Promise.all(alle.filter((f) => f.type.startsWith("image/")).slice(0, 4).map(bildAusDatei));
    const dokumente: SpreadsheetAttachment[] = [];
    for (const f of alle.filter((f) => !f.type.startsWith("image/") && isSupportedAttachment(f)).slice(0, 3)) {
      try { dokumente.push(await parseAttachment(f)); }
      catch (err) { setMeldungKurz(err instanceof ScanPdfDetectedError ? `${f.name}: gescanntes PDF ohne Text — im Sprachmodus nicht lesbar.` : `${f.name}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    if (bilder.length === 0 && dokumente.length === 0) { setMeldungKurz("Unterstützt: Bilder, PDF, Excel, CSV."); return; }
    if (zustandRef.current.phase === "ruhe") await wecken();
    const frage = eingabe.trim() || (dokumente.length ? "Sieh dir das angehängte Dokument an und sag mir, was darin für die Recherche wichtig ist." : "Sieh dir das angehängte Bild an und sag mir, was darauf für die Recherche wichtig ist.");
    setEingabe("");
    aktiv();
    const was = [bilder.length ? `${bilder.length} ${bilder.length === 1 ? "Bild" : "Bilder"}` : "", dokumente.length ? dokumente.map((d) => d.filename).join(", ") : ""].filter(Boolean).join(", ");
    logge("du", `${frage} (${was})`);
    const r = await window.api.sprache.auftrag({ conversationId, text: composePromptWithAttachments(frage, dokumente), images: bilder });
    if (r.laeuft) {
      setAuftragLaeuft(true);
      nachrichtEinlegen(`Der Nutzer hat angehängt: ${was}. Frage: "${frage}". AVA arbeitet daran; sag einen kurzen Satz und warte auf 'ERGEBNIS von AVA'.`);
    } else {
      setMeldungKurz(r.grund ?? "Auftrag nicht gestartet.");
    }
  };
  const [meldungKurz, setMeldungKurz] = useState<string | null>(null);
  useEffect(() => { if (!meldungKurz) return; const id = setTimeout(() => setMeldungKurz(null), 6000); return () => clearTimeout(id); }, [meldungKurz]);

  const beenden = () => {
    setSichtbar(false);
    setTimeout(() => navigate("/chat"), 320);
  };

  const tippen = async () => {
    const text = eingabe.trim();
    if (!text) return;
    setEingabe("");
    if (zustandRef.current.phase === "ruhe") await wecken();
    aktiv();
    logge("du", text);
    if (protoRef.current === "live") {
      // Kein Text-Eingang bei GPT Live: getippte Auftraege gehen direkt an
      // den Relay, die Stimme erfaehrt es als Kontext und liest das Ergebnis.
      const rf = rueckfrageRef.current;
      if (rf) { const r = await window.api.sprache.rueckfrage(rf.choiceId, text); if (r.ok) { setRueckfrage(null); rueckfrageRef.current = null; setAuftragLaeuft(true); } return; }
      const r = await window.api.sprache.auftrag({ conversationId, text });
      if (r.laeuft) { setAuftragLaeuft(true); delegationRef.current = null; nachrichtEinlegen(`Der Nutzer hat getippt: "${text.slice(0, 300)}". AVA arbeitet daran; sag einen kurzen Satz und warte auf das Ergebnis.`, false); }
      else setMeldungKurz(r.grund ?? "Auftrag nicht gestartet.");
      return;
    }
    nachrichtEinlegen(text);
  };

  const stummSchalten = () => {
    const neu = !stumm;
    setStumm(neu);
    verbindung.current?.mikrofon(!neu);
    if (protoRef.current === "realtime") senden({ type: "session.update", session: { audio: { input: { turn_detection: neu ? null : { type: "semantic_vad", interrupt_response: true, create_response: true } } } } });
  };

  const kugelZustand: KugelZustand = phase === "ruhe" ? "ruhe" : phase === "verbindet" || phase === "start" ? "verbindet" : aiSpricht ? "spricht" : nutzerSpricht ? "hoert" : auftragLaeuft || antwortet ? "denkt" : "wach";
  const hinweis = phase === "ruhe"
    ? (stand?.einstellungen.wachwort && stand.whisperBereit ? "Sag „Hey AVA“, um AVA zu aktivieren" : "Tippe auf die Kugel oder drücke die Leertaste, um AVA zu aktivieren")
    : phase === "verbindet" || phase === "start" ? "AVA kommt …"
    : countdown !== null ? `AVA hört noch ${countdown} s zu` : auftragLaeuft ? null : stumm ? "Mikrofon stumm. Leertaste gedrückt halten, um zu sprechen." : null;
  const hatBloecke = bloecke.length > 0 || rueckfrage !== null;

  // Ueber der GANZEN App rendern (Portal an body): innerhalb des Inhalts-
  // bereichs blieben Kopfzeile und Seitenleiste sichtbar.
  return createPortal(
    <div className={`sm ${sichtbar ? "sm--sichtbar" : ""} ${hatBloecke ? "sm--mit-bloecken" : ""}`} onClickCapture={(e) => {
      const a = (e.target as HTMLElement).closest("a");
      if (a) { e.preventDefault(); e.stopPropagation(); }
    }}>
      <div className="sm__buehne">
        <button type="button" className={`sm__kugel-knopf ${phase === "ruhe" ? "sm__kugel-knopf--ruhe" : ""}`} onClick={() => { if (phase === "ruhe") void wecken(); }} aria-label={phase === "ruhe" ? "AVA aktivieren" : "AVA"}>
          <SprachKugel zustand={kugelZustand} pegel={pegel} eingang={eingang} countdown={countdown} size={hatBloecke ? 220 : 360} />
        </button>
        {hinweis && <p className={`sm__hinweis ${countdown !== null ? "sm__hinweis--countdown" : ""}`}>{hinweis}</p>}
        {(auftragLaeuft || fortschritt) && (
          <div className="sm__arbeit">
            {auftragLaeuft && auftragStart !== null ? (
              <LaufStatus
                start={auftragStart}
                usage={fortschritt?.usage ?? null}
                laufend={(fortschritt?.schritte ?? []).filter((s) => s.status === "laeuft").length}
                text={(() => { const l = [...(fortschritt?.schritte ?? [])].reverse().find((s) => s.status === "laeuft"); return l ? `${l.label} …` : "AVA arbeitet …"; })()}
              />
            ) : fortschritt?.usage ? (
              <VerbrauchZeile usage={fortschritt.usage} />
            ) : null}
            {(fortschritt?.schritte.length ?? 0) > 0 && (
              <div className="sm__schritte">
                <button type="button" className="sm__schritte-kopf" onClick={() => setSchritteOffen((o) => !o)} aria-expanded={schritteOffen}>
                  {auftragLaeuft ? "Führt aus" : "Ausgeführt"}: {fortschritt!.schritte.length} {fortschritt!.schritte.length === 1 ? "Schritt" : "Schritte"}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ transform: schritteOffen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }} aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                </button>
                {schritteOffen && (
                  <ul className="sm__schritte-liste">
                    {fortschritt!.schritte.map((s) => (
                      <li key={s.id} className={`sm__schritt sm__schritt--${s.status}`}>
                        <span className="sm__schritt-marke" aria-hidden="true">{s.status === "laeuft" ? <span className="rl__spinner" /> : s.status === "ok" ? "✓" : "✗"}</span>
                        <span className="sm__schritt-name">{s.label}</span>
                        {s.preview && <span className="sm__schritt-preview">{s.preview}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
        {phase === "fehler" && fehler && (
          <div className="sm__fehler">
            <p className="sm__fehler-text">{fehler}</p>
            {fehlerDetail && fehlerDetail !== fehler && <p className="sm__fehler-detail">{fehlerDetail}</p>}
            <p className="sm__fehler-hilfe">
              {fehlerArt === "mikrofon-verweigert" && "AVA braucht das Mikrofon. Erlaube den Zugriff in den Systemeinstellungen und versuche es erneut."}
              {fehlerArt === "kein-mikrofon" && "Schließe ein Mikrofon an oder wähle eines in den Systemeinstellungen aus."}
              {fehlerArt === "netz" && "Prüfe die Internetverbindung. Hinter einem Firmen-Proxy oder einer Firewall kann WebRTC blockiert sein; dann hilft oft ein anderes Netz."}
              {fehlerArt === "schluessel" && "Prüfe den OpenAI-Schlüssel in den Einstellungen unter Modelle. Läuft der Sprachmodus über die Organisation, muss der Administrator den Schlüssel erneuern."}
              {fehlerArt === "kontingent" && "Bei OpenAI ist das Guthaben oder das Limit erschöpft. Lade Guthaben nach oder warte, bis das Limit zurückgesetzt wird."}
              {fehlerArt === "sonstiges" && "Versuche es erneut. Bleibt der Fehler, hilft ein Blick in die Protokolle."}
            </p>
            <div className="sm__fehler-knoepfe">
              <button type="button" className="btn small" onClick={() => void verbinden(true)}>Erneut verbinden</button>
              {(fehlerArt === "mikrofon-verweigert" || fehlerArt === "kein-mikrofon") && (
                <button type="button" className="btn small" onClick={() => void window.api.voice.openMicSettings()}>Mikrofon-Einstellungen öffnen</button>
              )}
              <button type="button" className="btn small" onClick={beenden}>Sprachmodus beenden</button>
            </div>
          </div>
        )}
        {hatBloecke && (
          <div className="sm__bloecke">
            {rueckfrage && (
              <div className="sm__block sm__rueckfrage">
                <p>{rueckfrage.prompt}</p>
                {rueckfrage.options?.length ? (
                  <div className="sm__rueckfrage-optionen">
                    {rueckfrage.options.map((o) => (
                      <button key={o.value} type="button" className="btn small" onClick={() => { void window.api.sprache.rueckfrage(rueckfrage.choiceId, o.value).then((r) => { if (r.ok) { setRueckfrage(null); setAuftragLaeuft(true); nachrichtEinlegen(`Der Nutzer hat auf dem Bildschirm gewählt: ${o.label}.`, false); } }); }}>{o.label}</button>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
            {bloecke.map((b) => (
              <div key={b.id} className={`sm__block ${b.gepinnt ? "sm__block--gepinnt" : ""}`}>
                <div className="sm__block-kopf">
                  <span className="muted small">{b.titel}</span>
                  <span className="sm__block-knoepfe">
                    <button type="button" className="btn small" onClick={() => setBloecke((alt) => alt.map((x) => x.id === b.id ? { ...x, gepinnt: !x.gepinnt } : x))} title={b.gepinnt ? "Lösen" : "Festpinnen"}>{b.gepinnt ? "Gepinnt" : "Pinnen"}</button>
                    <button type="button" className="btn small" onClick={() => setBloecke((alt) => alt.filter((x) => x.id !== b.id))} title="Schließen">Schließen</button>
                  </span>
                </div>
                {b.art === "chart" ? <ChartBlock raw={b.raw} /> : <BuyingCenterBlock raw={b.raw} />}
              </div>
            ))}
          </div>
        )}
      </div>
      {(meldungKurz || laufendeZeile || transkript.length > 0) && (
        <p className={`sm__transkript ${meldungKurz ? "sm__transkript--meldung" : ""}`}>{meldungKurz ?? (laufendeZeile || transkript[transkript.length - 1]?.text)}</p>
      )}
      <div className="sm__leiste">
        <form className="sm__eingabe" onSubmit={(e) => { e.preventDefault(); void tippen(); }}>
          <button type="button" className="sm__plus" onClick={() => dateiRef.current?.click()} title="Bild oder Dokument anhängen" aria-label="Bild oder Dokument anhängen">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <input value={eingabe} onChange={(e) => setEingabe(e.target.value)} placeholder="AVA fragen" aria-label="AVA fragen" onPaste={(e) => { const f = e.clipboardData?.files; if (f && f.length) { e.preventDefault(); void anhaengen(f); } }} />
          <input ref={dateiRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,.pdf,application/pdf,.xlsx,.xls,.csv,.tsv" multiple style={{ display: "none" }} onChange={(e) => { void anhaengen(e.target.files); e.target.value = ""; }} />
        </form>
        <button type="button" className={`sm__rund ${stumm ? "sm__rund--aus" : ""}`} onClick={stummSchalten} title={stumm ? "Mikrofon einschalten" : "Mikrofon stummschalten"} aria-label={stumm ? "Mikrofon einschalten" : "Mikrofon stummschalten"}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />{stumm && <path d="M4 4l16 16" />}</svg>
        </button>
        <button type="button" className="sm__rund sm__rund--x" onClick={beenden} title="Sprachmodus beenden" aria-label="Sprachmodus beenden">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    </div>,
    document.body,
  );
}
