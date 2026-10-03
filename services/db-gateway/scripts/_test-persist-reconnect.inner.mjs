// Ausfall 27.09.–03.10. nachstellen: Kanal bricht weg, AMQPClient verbindet
// sich selbst neu, der Persist-Bus muss den Konsumenten wieder anhaengen.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Lokale Werte: .env, dann .env.example (Platzhalter), Bus-URL aus master-data/.env.
for (const datei of ["../.env", "../.env.example", "../../../master-data/.env"]) {
  let text = "";
  try { text = readFileSync(new URL(datei, import.meta.url), "utf8"); } catch { continue; }
  for (const z of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(z.trim());
    if (!m) continue;
    if (datei.includes("master-data") && m[1] !== "EVENT_BUS_URL") continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
process.env.LOG_LEVEL = "warn";
const amqplib = (await import("amqplib")).default;
// Gegen den KOMPILIERTEN Stand (tsx stolpert ueber eine zirkulaere Importreihenfolge).
const { persistBus } = (await import(process.env.PERSIST_BUS_JS)).default;
await persistBus.ensureConnected();
let s = persistBus.status();
assert.equal(s.ok, true, "nach dem Start alle Bindungen aktiv");
const ziel = persistBus.zustaende[0];
const conn = await amqplib.connect(process.env.EVENT_BUS_URL);
const ch = await conn.createChannel();
const vorher = (await ch.checkQueue(ziel.queue)).consumerCount;
assert.ok(vorher >= 1, "Konsument vorhanden");
// Kanal hart schliessen (wie bei Broker-Neustart/Kanalfehler).
await ziel.client._channel.close();
const t0 = Date.now();
while (Date.now() - t0 < 40_000) {
  await new Promise((r) => setTimeout(r, 1000));
  if (persistBus.status().ok && ziel.neuAbonniert >= 1) break;
}
s = persistBus.status();
assert.equal(s.ok, true, "nach dem Abbruch wieder alle Bindungen aktiv");
assert.ok(ziel.neuAbonniert >= 1, "Waechter hat neu abonniert");
const nachher = (await ch.checkQueue(ziel.queue)).consumerCount;
assert.ok(nachher >= 1, `Konsument nach Wiederverbindung vorhanden (${nachher})`);
console.log(`Persist-Reconnect-Test ok: ${ziel.producer} nach ${Math.round((Date.now() - t0) / 1000)} s neu abonniert, Konsumenten ${vorher} → ${nachher}`);
await conn.close();
process.exit(0);
