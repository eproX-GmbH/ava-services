// Diktat aus der AVA-App (docs/PLAN_APP_PWA.md §3.6, P4): WAV 16 kHz mono.
// Lokal mit Whisper, wenn bereit; sonst OpenAI-Transkription über den
// OpenAI-Zugang dieser AVA (eigener Schlüssel, Organisation oder Azure-Brücke).

export interface TranskriptionDeps {
  whisper: { bereit: () => boolean; transkribieren: (wav: Uint8Array) => Promise<{ text: string }> };
  openaiZugang: () => Promise<{ apiKey: string; baseURL: string } | null>;
}

export async function transkribieren(deps: TranskriptionDeps, wav: Uint8Array): Promise<{ text: string; quelle: "whisper" | "openai" }> {
  if (wav.byteLength < 2000) return { text: "", quelle: "whisper" };
  if (deps.whisper.bereit()) {
    return { text: (await deps.whisper.transkribieren(wav)).text.trim(), quelle: "whisper" };
  }
  const z = await deps.openaiZugang();
  if (!z) throw new Error("Diktat braucht das lokale Sprachmodell (Whisper) oder einen OpenAI-Zugang.");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "diktat.wav");
  form.append("model", "gpt-4o-transcribe");
  form.append("language", "de");
  const res = await fetch(`${z.baseURL.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${z.apiKey}`, "x-ava-llm-channel": "chat", "x-ava-llm-quelle": "diktat" },
    body: form,
  });
  if (!res.ok) throw new Error(`Transkription fehlgeschlagen (${res.status}).`);
  const j = (await res.json()) as { text?: string };
  return { text: (j.text ?? "").trim(), quelle: "openai" };
}
