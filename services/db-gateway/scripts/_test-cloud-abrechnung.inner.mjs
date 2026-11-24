// Härtetest Abbestellen / Wieder buchen (Befund Joyce 2026-11-24): Kann ein Zustand entstehen,
// in dem der AVA-Server läuft, aber niemand zahlt? Oder einer, in dem der Kunde doppelt zahlt?
//
// Echte Abrechnungslogik (src/lib/cloud/abrechnung.ts) gegen eine Datenbank im Speicher (mit
// Transaktionen und Sperre) und ein nachgebautes Stripe-Abo. Das Stripe-Abo nennt das
// Periodenende wie die aktuelle API nur an den Posten, nicht am Abo.
//
// Unveränderliche Regeln nach jedem Schritt:
//   R1 Läuft der Server laut Soll, ist er für die laufende Periode bezahlt.
//   R2 Je Periode wird der Server höchstens einmal bezahlt.
//   R3 Gebuchte Server in der Datenbank = Menge des Server-Postens bei Stripe.
import assert from "node:assert/strict";

for (const k of ["DATABASE_URL", "EVENT_BUS_URL", "UPSTREAM_MASTER_DATA_URL", "UPSTREAM_COMPANY_PROFILE_URL", "UPSTREAM_COMPANY_CONTACT_URL", "UPSTREAM_COMPANY_PUBLICATION_URL", "UPSTREAM_WEBSITE_URL", "UPSTREAM_STRUCTURED_CONTENT_URL"]) {
  process.env[k] ??= k === "DATABASE_URL" ? "postgres://x:y@127.0.0.1:1/x" : k === "EVENT_BUS_URL" ? "amqp://127.0.0.1:1" : "http://127.0.0.1:1";
}
process.env.JWT_ISSUER ??= "https://issuer.test/realms/ava"; process.env.JWKS_URI ??= "http://127.0.0.1:1/jwks";
process.env.STRIPE_SECRET_KEY = "sk_test_haertetest";
process.env.STRIPE_PRICE_CLOUD = "price_cloud";
process.env.STRIPE_PRICE_PRO = "price_pro";
process.env.LOG_LEVEL = "fatal";

const Ab0 = await import("../src/lib/cloud/abrechnung.ts");
const Ab = Ab0.default ?? Ab0;
const A0 = await import("../src/lib/cloud/abgleich.ts");
const A = A0.default ?? A0;
const SC0 = await import("../src/lib/stripe-client.ts");
const SC = SC0.default ?? SC0;

let fehler = 0;
const pruefe = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.stack?.split("\n").slice(0, 4).join("\n       ")}`); } };

const TAG = 86_400_000;
const PREIS = 5000;
let uhr = Date.parse("2026-12-01T10:00:00Z");
Date.now = () => uhr;

// ---- Stripe-Attrappe ---------------------------------------------------------------------
function stripeWelt() {
  const S = {
    nr: 0, start: uhr - 5 * TAG, ende: uhr + 25 * TAG, status: "active", karteOk: true, ausfall: null,
    items: [{ id: "si_pro", price: "price_pro", quantity: 1 }, { id: "si_cloud", price: "price_cloud", quantity: 1 }],
    // Periode 0 ist mit dem Kauf bezahlt (Pro-Sitz + Server).
    rechnungen: [{ periode: 0, einheiten: 1, betrag: PREIS, bezahlt: true, art: "kauf" }],
    gutschriften: 0,
  };
  const cloud = () => S.items.find((i) => i.price === "price_cloud");
  const ausfallPruefen = () => {
    if (S.ausfall) { S.ausfall = null; throw Object.assign(new Error("Verbindung zu Stripe abgebrochen"), { type: "StripeConnectionError" }); }
  };
  function menge(neu, p) {
    ausfallPruefen();
    const alt = cloud()?.quantity ?? 0;
    const delta = neu - alt;
    if (delta > 0 && p.proration_behavior === "always_invoice") {
      const betrag = Math.round(PREIS * delta * (S.ende - uhr) / (S.ende - S.start));
      if (!S.karteOk && p.payment_behavior === "error_if_incomplete") {
        throw Object.assign(new Error("Your card was declined."), { type: "StripeCardError", statusCode: 402, code: "card_declined" });
      }
      S.rechnungen.push({ periode: S.nr, einheiten: delta, betrag, bezahlt: S.karteOk, art: "anteilig" });
      if (!S.karteOk) S.status = "past_due";
    }
    if (delta < 0 && p.proration_behavior !== "none") S.gutschriften++;
    return neu;
  }
  const stripe = SC.getStripe();
  stripe.subscriptions.retrieve = async (id) => {
    ausfallPruefen();
    return {
      id, status: S.status, customer: "cus_1",
      items: { data: S.items.map((i) => ({ id: i.id, price: { id: i.price }, quantity: i.quantity, current_period_start: Math.floor(S.start / 1000), current_period_end: Math.floor(S.ende / 1000) })) },
    };
  };
  stripe.subscriptionItems.create = async (p) => { const q = menge(p.quantity, p); S.items.push({ id: `si_${S.items.length}`, price: p.price, quantity: q }); return {}; };
  stripe.subscriptionItems.update = async (id, p) => { const q = menge(p.quantity, p); S.items.find((i) => i.id === id).quantity = q; return {}; };
  stripe.subscriptionItems.del = async (id, p) => { menge(0, p); S.items = S.items.filter((i) => i.id !== id); return {}; };
  return {
    S,
    menge: () => cloud()?.quantity ?? 0,
    bezahlt: (nr = S.nr) => S.rechnungen.filter((r) => r.periode === nr && r.bezahlt).reduce((n, r) => n + r.einheiten, 0),
    rechnungenSeit: (i) => S.rechnungen.slice(i),
    /** Periodenwechsel: Rechnung über die dann gebuchte Menge. */
    verlaengern() {
      S.nr++; S.start = S.ende; S.ende = S.start + 30 * TAG;
      const n = cloud()?.quantity ?? 0;
      if (n > 0) S.rechnungen.push({ periode: S.nr, einheiten: n, betrag: n * PREIS, bezahlt: true, art: "verlaengerung" });
    },
  };
}

// ---- Datenbank-Attrappe: Transaktionen mit Rücknahme, Sperre je Schlüssel ---------------------
function datenbank() {
  const db = {
    instanzen: new Map(), ereignisse: [], billingEvents: [],
    billing: { tenantId: "t1", kind: "organisation", mode: "sitze", tier: "pro", status: "active", stripeSubscriptionId: "sub_1", periodEnd: null, stripeModus: "live" },
    sitze: [{ id: "s1", tenantId: "t1", plan: "pro", actorId: "a1", endetAm: null, reduziertZum: null }],
  };
  const sperren = new Map();
  const tx = new Map(); // client → { undo: [], sperre: fn }
  function schreiben(client, id, neu) {
    const t = client && tx.get(client);
    if (t) t.undo.push([id, db.instanzen.has(id) ? structuredClone(db.instanzen.get(id)) : undefined]);
    db.instanzen.set(id, neu);
  }
  async function ausfuehren(client, sql, p = []) {
    sql = String(sql).replace(/\s+/g, " ").trim();
    if (sql === "BEGIN") { tx.set(client, { undo: [], freigeben: null, angehaengt: [] }); return { rows: [], rowCount: 0 }; }
    if (sql === "COMMIT" || sql === "ROLLBACK") {
      const t = tx.get(client);
      if (t && sql === "ROLLBACK") {
        for (const [id, alt] of t.undo.reverse()) alt === undefined ? db.instanzen.delete(id) : db.instanzen.set(id, alt);
        for (const [liste, x] of t.angehaengt) { const i = liste.indexOf(x); if (i >= 0) liste.splice(i, 1); }
      }
      t?.freigeben?.();
      tx.delete(client);
      return { rows: [], rowCount: 0 };
    }
    if (/pg_advisory_xact_lock/.test(sql)) {
      const k = p[0];
      while (sperren.has(k)) await sperren.get(k);
      let frei; sperren.set(k, new Promise((r) => { frei = r; }));
      tx.get(client).freigeben = () => { sperren.delete(k); frei(); };
      return { rows: [{}], rowCount: 1 };
    }
    const anhaengen = (liste, x) => { liste.push(x); const t = client && tx.get(client); if (t) t.angehaengt.push([liste, x]); };
    if (/FROM "TenantBilling"/.test(sql)) return { rows: [structuredClone(db.billing)], rowCount: 1 };
    if (/FROM "TenantMember"/.test(sql)) return { rows: [{}], rowCount: 1 };
    if (/FROM "Sitz"/.test(sql)) return { rows: db.sitze.filter((s) => s.tenantId === p[0]), rowCount: db.sitze.length };
    if (/^INSERT INTO "CloudEreignis"/.test(sql)) { anhaengen(db.ereignisse, { instanzId: p[0], art: p[1] ?? "abbestellt" }); return { rows: [], rowCount: 1 }; }
    if (/^INSERT INTO "BillingEvent"/.test(sql)) { anhaengen(db.billingEvents, { kind: p[1] }); return { rows: [], rowCount: 1 }; }
    const offen = (z) => !z.geloeschtAt;
    if (/^SELECT COUNT\(\*\)::text AS n FROM "CloudInstanz"/.test(sql)) {
      const n = [...db.instanzen.values()].filter((z) => z.tenantId === p[0] && offen(z) && !z.abbestelltZum).length;
      return { rows: [{ n: String(n) }], rowCount: 1 };
    }
    if (/^SELECT id, (zustand, )?"abbestelltZum" FROM "CloudInstanz"|^SELECT id, zustand(, "abbestelltZum")? FROM "CloudInstanz"/.test(sql)) {
      const rows = [...db.instanzen.values()].filter((z) => z.tenantId === p[0] && z.actorId === p[1] && offen(z)).map((z) => ({ id: z.id, zustand: z.zustand, abbestelltZum: z.abbestelltZum ? new Date(z.abbestelltZum) : null }));
      return { rows, rowCount: rows.length };
    }
    if (/^UPDATE "CloudInstanz" SET "abbestelltZum" = now\(\).*RETURNING id/.test(sql)) {
      const rows = [];
      for (const z of [...db.instanzen.values()]) {
        if (z.tenantId !== p[0] || !offen(z) || z.abbestelltZum || z.zustand === "zahlung_offen") continue;
        schreiben(client, z.id, { ...z, abbestelltZum: new Date(uhr).toISOString() }); rows.push({ id: z.id });
      }
      return { rows, rowCount: rows.length };
    }
    if (/^SELECT id, "actorId" FROM "CloudInstanz" WHERE "tenantId" = \$1 AND zustand = 'zahlung_offen'/.test(sql)) {
      const rows = [...db.instanzen.values()].filter((z) => z.tenantId === p[0] && z.zustand === "zahlung_offen" && offen(z)).map((z) => ({ id: z.id, actorId: z.actorId }));
      return { rows, rowCount: rows.length };
    }
    if (/^UPDATE "CloudInstanz" SET "abbestelltZum" = NULL, "gewuenscht" = 'laufen'/.test(sql)) {
      schreiben(client, p[0], { ...db.instanzen.get(p[0]), abbestelltZum: null, gewuenscht: "laufen" }); return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE "CloudInstanz" SET "abbestelltZum" = \$2/.test(sql)) {
      schreiben(client, p[0], { ...db.instanzen.get(p[0]), abbestelltZum: new Date(p[1]).toISOString() }); return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE "CloudInstanz" SET zustand = 'geloescht'/.test(sql)) {
      const z = db.instanzen.get(p[0]);
      if (!z || (/AND zustand = 'zahlung_offen'/.test(sql) && z.zustand !== "zahlung_offen")) return { rows: [], rowCount: 0 };
      schreiben(client, p[0], { ...z, zustand: "geloescht", gewuenscht: "gestoppt", geloeschtAt: new Date(uhr).toISOString() }); return { rows: [], rowCount: 1 };
    }
    throw new Error(`Attrappe kennt die Abfrage nicht: ${sql.slice(0, 120)}`);
  }
  let nr = 0;
  const pool = {
    query: (sql, p) => ausfuehren(null, sql, p),
    connect: async () => { const client = { id: ++nr, query: (sql, p) => ausfuehren(client, sql, p), release() {} }; return client; },
  };
  const betrieb = {
    async anlegen(e) {
      const da = [...db.instanzen.values()].find((z) => z.tenantId === e.tenantId && z.actorId === e.actorId && !z.geloeschtAt);
      if (da) return structuredClone(da);
      const z = { id: `i${db.instanzen.size + 1}`, tenantId: e.tenantId, actorId: e.actorId, zustand: e.zahlungOffen ? "zahlung_offen" : "wird_angelegt", gewuenscht: "laufen", grund: null, abbestelltZum: null, geloeschtAt: null };
      db.instanzen.set(z.id, z); // eigene Verbindung, sofort festgeschrieben
      return structuredClone(z);
    },
    async stand(id) { return structuredClone(db.instanzen.get(id)); },
    async freigeben(id) { const z = db.instanzen.get(id); if (z?.zustand !== "zahlung_offen") return null; z.zustand = "wird_angelegt"; return structuredClone(z); },
  };
  return { db, pool, betrieb };
}

/** Welt mit einem gebuchten, laufenden, für Periode 0 bezahlten Server. */
function welt(opt = {}) {
  const st = stripeWelt();
  const d = datenbank();
  d.db.instanzen.set("i1", { id: "i1", tenantId: "t1", actorId: "a1", zustand: "laeuft", gewuenscht: "laufen", grund: null, abbestelltZum: null, geloeschtAt: null });
  if (opt.periodEndBekannt) d.db.billing.periodEnd = new Date(st.S.ende);
  const a = { tenantId: "t1", actorId: "a1", von: "admin1" };
  const instanz = () => [...d.db.instanzen.values()].find((z) => !z.geloeschtAt) ?? null;
  const soll = () => {
    const i = instanz();
    if (!i) return "gestoppt";
    return A.sollBestimmen(i, { kontoSperre: null, abrechnung: d.db.billing.status, offenSeit: null }, uhr).soll;
  };
  const regeln = (wo) => {
    const i = instanz();
    const gebucht = i && !i.abbestelltZum ? 1 : 0;
    assert.equal(gebucht, st.menge(), `R3 ${wo}: Datenbank ${gebucht} gebucht, Stripe rechnet ${st.menge()} ab`);
    if (soll() === "laufen") assert.ok(st.bezahlt() >= 1, `R1 ${wo}: Server läuft in Periode ${st.S.nr}, bezahlt sind ${st.bezahlt()}`);
    assert.ok(st.bezahlt() <= 1, `R2 ${wo}: Periode ${st.S.nr} ist ${st.bezahlt()}-mal bezahlt`);
    assert.equal(st.S.gutschriften, 0, "keine Gutschrift beim Abbestellen");
  };
  const zeit = (ms) => {
    uhr += ms;
    while (uhr >= st.S.ende) {
      st.verlaengern();
      // Der Abo-Webhook trägt das neue Ende ein; mal kommt er, mal nicht (stale/fehlend).
      if (opt.webhookFuellt) d.db.billing.periodEnd = new Date(st.S.ende);
    }
  };
  return { st, ...d, a, instanz, soll, regeln, zeit };
}

console.log("Hilfen");
await pruefe("Periodenende am Abo (alte API) und an den Posten (neue API)", () => {
  assert.equal(SC.periodenEndeUnix({ current_period_end: 100 }), 100);
  assert.equal(SC.periodenEndeUnix({ items: { data: [{ current_period_end: 300 }, { current_period_end: 200 }] } }), 200);
  assert.equal(SC.periodenEndeUnix({ items: { data: [] } }), null);
  assert.equal(SC.periodenEndeUnix(null), null);
});
await pruefe("Rechnung mit Server-Posten erkennen (alte und neue Zeilenform)", () => {
  assert.equal(Ab.rechnungHatPreis({ lines: { data: [{ price: { id: "price_cloud" } }] } }, "price_cloud"), true);
  assert.equal(Ab.rechnungHatPreis({ lines: { data: [{ pricing: { price_details: { price: "price_cloud" } } }] } }, "price_cloud"), true);
  assert.equal(Ab.rechnungHatPreis({ lines: { data: [{ price: { id: "price_pro" } }], has_more: false } }, "price_cloud"), false);
  assert.equal(Ab.rechnungHatPreis({ lines: { data: [{ price: { id: "price_pro" } }], has_more: true } }, "price_cloud"), null, "nicht alle Zeilen da");
  assert.equal(Ab.rechnungHatPreis({}, "price_cloud"), null);
});

console.log("Abbestellen und Wieder buchen");
await pruefe("Joyces Ablauf: Abbestellen läuft bis Zyklusende, auch wenn das Ende nur an den Stripe-Posten steht", async () => {
  const w = welt();
  const { bis } = await Ab.cloudAbbestellen(w.pool, w.a);
  assert.equal(Date.parse(bis), Math.floor(w.st.S.ende / 1000) * 1000, "Ende der bezahlten Periode, nicht sofort");
  assert.equal(w.soll(), "laufen", "läuft weiter bis zum Ende");
  w.regeln("nach Abbestellen");
});
await pruefe("Zehnmal hin und her in derselben Periode: keine einzige neue Rechnung, Server läuft", async () => {
  const w = welt();
  const vorher = w.st.S.rechnungen.length;
  for (let i = 0; i < 10; i++) {
    await Ab.cloudAbbestellen(w.pool, w.a); w.regeln(`Abbestellen ${i}`);
    await Ab.cloudEinschalten(w.pool, w.betrieb, w.a); w.regeln(`Buchen ${i}`);
    w.zeit(60_000);
  }
  assert.deepEqual(w.st.rechnungenSeit(vorher), []);
  assert.equal(w.soll(), "laufen");
});
await pruefe("Abgelaufen: zweites Abbestellen (alter Tab) schiebt das Ende nicht in die unbezahlte Periode", async () => {
  // Mit gespeichertem Periodenende (Webhook trägt es ein): Sonst stünde das zweite Ende in der
  // neuen, unbezahlten Periode und der pausierte Server liefe wieder an.
  const w = welt({ periodEndBekannt: true, webhookFuellt: true });
  const { bis } = await Ab.cloudAbbestellen(w.pool, w.a);
  w.zeit(26 * TAG); // Periodenwechsel ohne Server
  assert.equal(w.soll(), "gestoppt");
  const zweit = await Ab.cloudAbbestellen(w.pool, w.a);
  assert.equal(zweit.bis, bis, "Ende bleibt");
  assert.equal(w.soll(), "gestoppt", "läuft nicht wieder an");
  w.regeln("nach zweitem Abbestellen");
});
await pruefe("Wieder buchen nach Zyklusende mit abgelehnter Karte: Fehler „zahlung“, Server bleibt pausiert, nichts geändert", async () => {
  const w = welt();
  await Ab.cloudAbbestellen(w.pool, w.a);
  w.zeit(26 * TAG);
  w.st.S.karteOk = false;
  const vorher = structuredClone(w.instanz());
  await assert.rejects(() => Ab.cloudEinschalten(w.pool, w.betrieb, w.a), (e) => e.code === "zahlung" && /Zahlung hat nicht geklappt/.test(e.message));
  assert.deepEqual(w.instanz(), vorher, "Datenbank zurückgerollt");
  assert.equal(w.soll(), "gestoppt");
  assert.equal(w.st.S.rechnungen.filter((r) => !r.bezahlt).length, 0, "keine offene Rechnung");
  w.regeln("nach abgelehnter Karte");
});
await pruefe("Wieder buchen nach Zyklusende: genau eine anteilige Rechnung, dann läuft er", async () => {
  const w = welt();
  await Ab.cloudAbbestellen(w.pool, w.a);
  w.zeit(26 * TAG + 10 * TAG); // 10 Tage in der neuen Periode
  const vorher = w.st.S.rechnungen.length;
  await Ab.cloudEinschalten(w.pool, w.betrieb, w.a);
  const neu = w.st.rechnungenSeit(vorher);
  assert.equal(neu.length, 1);
  assert.ok(neu[0].bezahlt && neu[0].betrag < PREIS && neu[0].betrag > 0, `anteilig: ${neu[0].betrag}`);
  assert.equal(w.soll(), "laufen");
  w.regeln("nach Wiederbuchen");
});
await pruefe("Stripe fällt beim Wiederbuchen aus: Fehler „stripe“, Datenbank unverändert", async () => {
  const w = welt();
  await Ab.cloudAbbestellen(w.pool, w.a);
  w.zeit(26 * TAG);
  w.st.S.ausfall = "netz";
  const vorher = structuredClone(w.instanz());
  await assert.rejects(() => Ab.cloudEinschalten(w.pool, w.betrieb, w.a), (e) => e.code === "stripe");
  assert.deepEqual(w.instanz(), vorher);
  w.regeln("nach Ausfall");
});
await pruefe("Stripe fällt beim Abbestellen aus: nichts abbestellt, Menge bleibt (kein stiller Rest wie früher)", async () => {
  const w = welt();
  w.st.S.ausfall = "netz";
  await assert.rejects(() => Ab.cloudAbbestellen(w.pool, w.a), (e) => e.code === "stripe");
  assert.equal(w.instanz().abbestelltZum, null);
  w.regeln("nach Ausfall beim Abbestellen");
});
await pruefe("Doppelklick „Wieder buchen“ nach Zyklusende: eine Rechnung, nicht zwei", async () => {
  const w = welt();
  await Ab.cloudAbbestellen(w.pool, w.a);
  w.zeit(27 * TAG);
  const vorher = w.st.S.rechnungen.length;
  await Promise.all([Ab.cloudEinschalten(w.pool, w.betrieb, w.a), Ab.cloudEinschalten(w.pool, w.betrieb, w.a)]);
  assert.equal(w.st.rechnungenSeit(vorher).length, 1);
  w.regeln("nach Doppelklick");
});
await pruefe("Gleichzeitig Abbestellen und Buchen (zwei Tabs): Datenbank und Stripe passen zusammen", async () => {
  for (const reihenfolge of [0, 1]) {
    const w = welt();
    const ops = [() => Ab.cloudAbbestellen(w.pool, w.a), () => Ab.cloudEinschalten(w.pool, w.betrieb, w.a)];
    if (reihenfolge) ops.reverse();
    await Promise.all(ops.map((f) => f()));
    w.regeln(`zwei Tabs, Reihenfolge ${reihenfolge}`);
  }
});

console.log("Abo der Organisation beendet");
await pruefe("Abo beendet, später neues Abo nur mit Sitzen: Server bleibt pausiert, bis er bezahlt wieder gebucht ist", async () => {
  const w = welt({ periodEndBekannt: true, webhookFuellt: true });
  // Abo endet (z. B. alle Sitze gekündigt): Stripe beendet es samt Server-Posten.
  w.db.billing.status = "canceled";
  w.st.S.items = []; w.st.S.status = "canceled";
  assert.equal(await Ab.cloudAboBeendet(w.pool, "t1"), 1, "Server als abbestellt vermerkt");
  assert.equal(w.soll(), "gestoppt");
  assert.equal(await Ab.cloudAboBeendet(w.pool, "t1"), 0, "zweiter Webhook ändert nichts");
  await assert.rejects(() => Ab.cloudEinschalten(w.pool, w.betrieb, w.a), (e) => e.code === "braucht_checkout" && /Abo deiner Organisation ist beendet/.test(e.message));
  // Neues Abo nur mit einem Sitz (Konsole): Status wieder aktiv, kein Server-Posten.
  w.zeit(3 * TAG);
  w.st.S.nr++; w.st.S.start = uhr; w.st.S.ende = uhr + 30 * TAG; w.st.S.status = "active";
  w.st.S.items = [{ id: "si_pro2", price: "price_pro", quantity: 1 }];
  w.db.billing.status = "active"; w.db.billing.periodEnd = new Date(w.st.S.ende);
  assert.equal(w.soll(), "gestoppt", "läuft NICHT stillschweigend wieder an");
  w.regeln("neues Abo ohne Server");
  await Ab.cloudEinschalten(w.pool, w.betrieb, w.a);
  assert.equal(w.soll(), "laufen");
  assert.equal(w.st.bezahlt(), 1, "anteilig bezahlt");
  w.regeln("nach Wiederbuchen auf dem neuen Abo");
});
await pruefe("Kauf nach beendetem Abo: bezahlter Checkout holt den pausierten Server zurück", async () => {
  const w = welt();
  w.db.instanzen.get("i1").abbestelltZum = new Date(uhr - TAG).toISOString();
  const frei = await Ab.cloudCheckoutAbgeschlossen(w.pool, w.betrieb, { metadata: { cloudFuer: "a1" }, payment_status: "paid" }, "t1");
  assert.equal(frei.length, 0, "keine neue Instanz");
  assert.equal(w.instanz().abbestelltZum, null);
  assert.equal(w.soll(), "laufen");
});

console.log("Neue Buchung");
await pruefe("Stripe-Fehler bei neuer Buchung: keine hängende „zahlung_offen“-Buchung, die eine fremde Zahlung freigäbe", async () => {
  const w = welt();
  w.db.instanzen.clear();
  w.st.S.items = w.st.S.items.filter((i) => i.price !== "price_cloud");
  w.st.S.ausfall = "netz";
  await assert.rejects(() => Ab.cloudEinschalten(w.pool, w.betrieb, w.a), (e) => e.code === "stripe");
  assert.equal(w.instanz(), null, "Buchung zurückgenommen");
  w.regeln("nach Fehler bei neuer Buchung");
});
await pruefe("Fremde bezahlte Rechnung (nur Sitz) gibt eine offene Server-Buchung nicht frei", async () => {
  const w = welt();
  w.db.instanzen.clear();
  w.db.instanzen.set("i9", { id: "i9", tenantId: "t1", actorId: "a1", zustand: "zahlung_offen", gewuenscht: "laufen", abbestelltZum: null, geloeschtAt: null });
  const frei = await Ab.cloudZahlungEingegangen(w.pool, w.betrieb, "t1", { lines: { data: [{ price: { id: "price_pro" } }], has_more: false } });
  assert.equal(frei.length, 0);
  assert.equal(w.instanz().zustand, "zahlung_offen");
  const frei2 = await Ab.cloudZahlungEingegangen(w.pool, w.betrieb, "t1", { lines: { data: [{ pricing: { price_details: { price: "price_cloud" } } }] } });
  assert.equal(frei2.length, 1, "die Server-Rechnung gibt frei");
});

console.log("Zufallslauf (feste Startwerte)");
function zufall(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
for (const seed of [1, 7, 42, 2026, 31337]) {
  await pruefe(`600 zufällige Schritte, Startwert ${seed}: R1–R3 halten immer`, async () => {
    uhr = Date.parse("2026-12-01T10:00:00Z");
    const r = zufall(seed);
    const w = welt({ webhookFuellt: seed % 2 === 0, periodEndBekannt: seed % 3 === 0 });
    const erwartet = new Set(["zahlung", "stripe"]);
    const versuch = async (f) => { try { await f(); } catch (e) { if (!erwartet.has(e.code)) throw e; } };
    for (let i = 0; i < 600; i++) {
      const x = r();
      let wo;
      if (x < 0.25) { wo = "abbestellen"; await versuch(() => Ab.cloudAbbestellen(w.pool, w.a)); }
      else if (x < 0.5) { wo = "buchen"; await versuch(() => Ab.cloudEinschalten(w.pool, w.betrieb, w.a)); }
      else if (x < 0.6) { wo = "parallel"; await Promise.all([versuch(() => Ab.cloudAbbestellen(w.pool, w.a)), versuch(() => Ab.cloudEinschalten(w.pool, w.betrieb, w.a)), versuch(() => Ab.cloudEinschalten(w.pool, w.betrieb, w.a))]); }
      else if (x < 0.8) { wo = "zeit"; w.zeit(Math.floor(r() * 12 * TAG)); }
      else if (x < 0.88) { wo = "karte"; w.st.S.karteOk = r() < 0.6; }
      else if (x < 0.94) { wo = "ausfall"; w.st.S.ausfall = "netz"; }
      else { wo = "ende vergessen"; w.db.billing.periodEnd = r() < 0.5 ? null : new Date(uhr - TAG); }
      w.regeln(`Schritt ${i} (${wo}, Periode ${w.st.S.nr})`);
    }
  });
}

console.log(fehler ? `\n${fehler} Fehler` : "\nalles gruen");
process.exit(fehler ? 1 : 0);
