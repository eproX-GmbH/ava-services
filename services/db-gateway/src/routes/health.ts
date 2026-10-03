import { Hono } from "hono";

// Liveness probe only — no dependency checks. Readiness (with upstream DB
// ping) can be added once operational endpoints land; per D11 the client
// fails fast on first real request anyway.
//
// 2026-10-03: /health/persist zeigt, ob alle Persist-Queues einen aktiven
// Konsumenten haben (Ausfall 27.09.–03.10.: Verbindung da, Konsument weg,
// /health trotzdem gruen). Bewusst NICHT im Fly-Check: ein 503 dort nimmt
// die einzige Maschine aus dem Routing. Selbstheilung macht der Waechter im
// Persist-Bus (neu abonnieren, nach 5 Min. Prozessende → Fly-Neustart).
export const healthRouter = new Hono()
  .get("/", (c) => c.json({ status: "ok", service: "db-gateway", version: "0.1.0" }))
  .get("/persist", async (c) => {
    const { persistBus } = await import("../lib/persist-bus");
    const { transactionProgressBus } = await import("../lib/event-bus");
    const s = persistBus.status();
    const fortschritt = transactionProgressBus.istVerbunden();
    const ok = s.ok && fortschritt;
    return c.json({ status: ok ? "ok" : "gestoert", ...s, ok, statusmeldungen: fortschritt }, ok ? 200 : 503);
  });
