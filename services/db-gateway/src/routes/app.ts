// App-Kanal (docs/PLAN_APP_PWA.md §3.2): die AVA-App (app.ava.bi) spricht über
// diese Routen mit der laufenden AVA des Nutzers.
//
//   GET  /v1/app/strom          Server-Sent Events: Frames der AVA (Last-Event-ID)
//   POST /v1/app/anfrage/{art}  Anfrage an die AVA (Chat senden, Gespräche, Rückfragen …)
//
// Die AVA wählt der Gateway wie bei MCP (Server vor Desktop), überschreibbar mit
// ?instanz=<id>. Ohne verbundene AVA: 409 ava_offline.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { authMiddleware } from "../middleware/auth";
import { AppStrom } from "../lib/app-strom";
import { kopfRelais } from "../lib/kopf-relais";
import { logger } from "../lib/logger";

/** Erlaubte Anfragen und ihre Frist. */
const ARTEN: Record<string, number> = {
  stand: 10_000,
  senden: 20_000,
  abbrechen: 10_000,
  warteschlange_entfernen: 10_000,
  antwort: 10_000,
  offene_fragen: 10_000,
  gespraeche: 15_000,
  gespraech: 30_000,
  gespraech_loeschen: 15_000,
  bild: 30_000,
  anhang_teil: 30_000,
  anhang_fertig: 90_000,
  transkribieren: 120_000,
  sprache_stand: 10_000,
  sprache_einschalten: 10_000,
  sprache_sitzung: 30_000,
  sprache_live: 30_000,
  sprache_auftrag: 20_000,
  sprache_rueckfrage: 10_000,
  sprache_abbrechen: 10_000,
  sprache_verbrauch: 10_000,
  meldungen: 15_000,
  meldung_status: 10_000,
  push_schluessel: 10_000,
  push_abo: 10_000,
  push_test: 20_000,
};

export const appStrom = new AppStrom((actorId, an) => {
  void kopfRelais.appAnfrage(actorId, "abo", { an }, { timeoutMs: 5_000 });
});
kopfRelais.onAppFrame((actorId, instanzId, frame) => appStrom.veroeffentlichen(actorId, { instanz: instanzId, ...(frame as Record<string, unknown>) }));

export const appRouter = new Hono();
appRouter.use("/v1/app/*", authMiddleware);

appRouter.get("/v1/app/strom", (c) => {
  const auth = c.get("auth");
  const letzte = Number(c.req.header("last-event-id") ?? c.req.query("seit") ?? NaN);
  return streamSSE(c, async (stream) => {
    const warte: Array<{ id: number; daten: string }> = [];
    let wecken: (() => void) | null = null;
    const ab = appStrom.abonnieren(auth.actorId, Number.isFinite(letzte) ? letzte : null, (e) => {
      warte.push({ id: e.id, daten: e.daten });
      wecken?.();
    });
    let offen = true;
    stream.onAbort(() => {
      offen = false;
      wecken?.();
    });
    // Erster Stand, damit die App sofort weiß, ob eine AVA da ist.
    await stream.writeSSE({ event: "stand", data: JSON.stringify({ verbunden: kopfRelais.instanzen(auth.actorId).some((i) => i.verbunden) }) });
    const ping = setInterval(() => {
      void stream.writeSSE({ event: "ping", data: "" }).catch(() => undefined);
    }, 20_000);
    try {
      while (offen) {
        while (warte.length) {
          const e = warte.shift()!;
          await stream.writeSSE({ id: String(e.id), event: "frame", data: e.daten });
        }
        await new Promise<void>((r) => {
          wecken = r;
          setTimeout(r, 25_000);
        });
        wecken = null;
      }
    } finally {
      clearInterval(ping);
      ab();
    }
  });
});

appRouter.post("/v1/app/anfrage/:art", async (c) => {
  const auth = c.get("auth");
  const art = c.req.param("art");
  const frist = ARTEN[art];
  if (!frist) return c.json({ code: "unbekannt", message: `Unbekannte Anfrage: ${art}` }, 404);
  let daten: Record<string, unknown> = {};
  try {
    const roh = await c.req.json();
    if (roh && typeof roh === "object") daten = roh as Record<string, unknown>;
  } catch {
    /* leerer Body */
  }
  const r = await kopfRelais.appAnfrage(auth.actorId, art, daten, { instanzId: c.req.query("instanz") ?? null, timeoutMs: frist });
  if (!r) return c.json({ code: "ava_offline", message: "Deine AVA ist gerade nicht verbunden (Desktop-App oder Server läuft nicht)." }, 409);
  let inhalt: unknown;
  try {
    inhalt = JSON.parse(r.text);
  } catch {
    inhalt = { message: r.text };
  }
  if (r.isError) {
    const code = (inhalt as { code?: string })?.code ?? "fehler";
    const status = code === "zeitueberschreitung" ? 504 : code === "beschaeftigt" ? 429 : code === "nicht_verfuegbar" ? 501 : 400;
    logger.info({ actorId: auth.actorId, art, code }, "[app] Anfrage abgelehnt");
    return c.json({ ...(inhalt as object), instanz: r.instanz }, status);
  }
  return c.json({ ergebnis: inhalt, instanz: r.instanz });
});
