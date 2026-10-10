// Azure-Bruecke gegen einen nachgebauten Azure-Endpunkt (lokal, http):
// Deployment-Uebersetzung, Azure-Schluessel, Streaming, Abweisung, AI SDK.
import { createServer } from "node:http";
// TS-Module ueber tsx; unter Node 24 kommen benannte Exporte teils als default.
const load = async (p) => {
  const m = await import(p);
  return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m;
};
const { AzureBruecke } = await load("../src/main/agent/providers/azure-bruecke.ts");
const { azureEndpointNormalisieren, azureDeployment, deploymentsNormalisieren } = await load("../src/shared/azure-openai.ts");
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";

let fehler = 0;
const ok = (bed, text) => {
  console.log(`${bed ? "✓" : "✗"} ${text}`);
  if (!bed) fehler++;
};

// 1. Hilfsfunktionen
ok(azureEndpointNormalisieren("firma.openai.azure.com/openai/v1/") === "https://firma.openai.azure.com", "Endpunkt wird normalisiert");
let geworfen = false;
try { azureEndpointNormalisieren("https://evil.example.com"); } catch { geworfen = true; }
ok(geworfen, "fremde Hosts werden abgewiesen");
ok(azureDeployment({ deployments: { "gpt-5": "chat-prod", "*": "standard" } }, "gpt-5") === "chat-prod", "Zuordnung je Modell");
ok(azureDeployment({ deployments: { "*": "standard" } }, "gpt-5-mini") === "standard", "Rueckfall '*'");
ok(azureDeployment({ deployments: {} }, "gpt-5-mini") === "gpt-5-mini", "ohne Zuordnung gleichnamig");
geworfen = false;
try { deploymentsNormalisieren({ x: "a b" }); } catch { geworfen = true; }
ok(geworfen, "ungueltige Deployment-Namen werden abgewiesen");

// 2. Nachgebauter Azure-Endpunkt
const gesehen = [];
const azure = createServer(async (req, res) => {
  let body = "";
  for await (const t of req) body += t;
  const json = body ? JSON.parse(body) : null;
  gesehen.push({ pfad: req.url, apiKey: req.headers["api-key"], auth: req.headers.authorization, model: json?.model, stream: json?.stream });
  if (json?.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (c) => res.write(`data: ${JSON.stringify(c)}\n\n`);
    chunk({ id: "1", object: "chat.completion.chunk", created: 1, model: json.model, choices: [{ index: 0, delta: { role: "assistant", content: "Hal" }, finish_reason: null }] });
    await new Promise((r) => setTimeout(r, 30));
    chunk({ id: "1", object: "chat.completion.chunk", created: 1, model: json.model, choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] });
    res.end("data: [DONE]\n\n");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "1", object: "chat.completion", created: 1, model: json?.model ?? "?", choices: [{ index: 0, message: { role: "assistant", content: "Hallo aus Azure" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } }));
});
await new Promise((r) => azure.listen(0, "127.0.0.1", r));
const azurePort = azure.address().port;

const bruecke = new AzureBruecke({
  ziel: async () => ({ cfg: { endpoint: `http://127.0.0.1:${azurePort}`, deployments: { "gpt-5-mini": "firma-mini", "*": "firma-standard" } }, key: "AZURE-KEY-123" }),
});
const z = await bruecke.zugang();
ok(z.baseURL.startsWith("http://127.0.0.1:") && z.baseURL.endsWith("/v1"), "Bruecke lauscht nur auf 127.0.0.1");

// 3. Direkter Aufruf
const r1 = await fetch(`${z.baseURL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${z.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }) });
const j1 = await r1.json();
const g1 = gesehen.at(-1);
ok(r1.status === 200 && j1.choices[0].message.content === "Hallo aus Azure", "Antwort kommt durch");
ok(g1.pfad === "/openai/v1/chat/completions", `Pfad bei Azure: ${g1.pfad}`);
ok(g1.model === "firma-mini", `Modell → Deployment (${g1.model})`);
ok(g1.apiKey === "AZURE-KEY-123" && g1.auth === "Bearer AZURE-KEY-123", "Azure-Schluessel als api-key und Bearer");
ok(!JSON.stringify(gesehen).includes(z.apiKey), "Geheimnis der Bruecke erreicht Azure nie");

// 4. Abweisungen
const r2 = await fetch(`${z.baseURL}/chat/completions`, { method: "POST", body: "{}" });
ok(r2.status === 401, "ohne Schluessel 401");
const r3 = await fetch(z.baseURL.replace("/v1", "/fremd"), { headers: { authorization: `Bearer ${z.apiKey}` } });
ok(r3.status === 404, "fremder Pfad 404");

// 5. AI SDK (wie Chat und Producer): Chat-API, Streaming, Rueckfall '*'
const openai = createOpenAI({ baseURL: z.baseURL, apiKey: z.apiKey });
const t = await generateText({ model: openai.chat("gpt-5"), prompt: "hi" });
ok(t.text === "Hallo aus Azure" && gesehen.at(-1).model === "firma-standard", `AI SDK generateText, '*' → ${gesehen.at(-1).model}`);
const s = streamText({ model: openai.chat("gpt-5-mini"), prompt: "hi" });
let text = "";
for await (const teil of s.textStream) text += teil;
ok(text === "Hallo" && gesehen.at(-1).stream === true && gesehen.at(-1).model === "firma-mini", `AI SDK Streaming („${text}“)`);

// 6. OPENAI_BASE_URL wie bei den Producern (AI SDK liest die Umgebung)
process.env.OPENAI_BASE_URL = z.baseURL;
const ausUmgebung = createOpenAI({ apiKey: z.apiKey });
const t2 = await generateText({ model: ausUmgebung.chat("gpt-5-mini"), prompt: "hi" });
ok(t2.text === "Hallo aus Azure", "Producer-Weg ueber OPENAI_BASE_URL");

// 7. openai-Paket wie im Website-Producer (Responses API, festes Modell gpt-5-mini)
try {
  const { createRequire } = await import("node:module");
  const req = createRequire(new URL("../resources/producers/website/package.json", import.meta.url));
  const OpenAI = req("openai").default ?? req("openai");
  const client = new OpenAI({ apiKey: z.apiKey });
  await client.chat.completions.create({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] });
  ok(gesehen.at(-1).model === "firma-mini" && gesehen.at(-1).apiKey === "AZURE-KEY-123", "openai-Paket (Website-Producer) ueber OPENAI_BASE_URL");
} catch (err) {
  console.log(`· openai-Paket nicht geprueft (${err instanceof Error ? err.message : err})`);
}

bruecke.stop();
azure.close();
console.log(fehler ? `\n${fehler} Fehler` : "\nAlle Pruefungen gruen.");
process.exit(fehler ? 1 : 0);
