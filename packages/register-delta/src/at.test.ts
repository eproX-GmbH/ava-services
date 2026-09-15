import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AT_BEGRIFFE, AT_GERICHTE, companyIdAt, istFirmenbuchnummer, trefferAt, JustizOnlineClient } from "./at-firmenbuch";
import { parseEdikteListe, parseEdikteVerfahren, meldungenAusVerfahren, kategorieAt, datumLang, companyIdAusVerfahren } from "./at-edikte";
import { fuehreJobAus } from "./jobs";
import { Taktgeber } from "./takt";

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, "..", "src", "fixtures", n), "utf8");

test("companyIdAt: Nummer ohne fuehrende Nullen, Buchstabe gross, FN-Praefix erlaubt", () => {
  assert.equal(companyIdAt("56247t"), "AT_FN56247T");
  assert.equal(companyIdAt("FN 588123m"), "AT_FN588123M");
  assert.equal(companyIdAt("012345a"), "AT_FN12345A");
  assert.throws(() => companyIdAt("588123"));
  assert.throws(() => companyIdAt("WIEN_1"));
  assert.equal(istFirmenbuchnummer("588123"), false);
  assert.equal(AT_BEGRIFFE.length, 260);
  assert.equal(Object.keys(AT_GERICHTE).length, 16);
});

test("trefferAt: Suchtreffer und Detail auf die Gateway-Zeile", () => {
  const s = trefferAt({ id: "612680a_1", fnr: "612680a", status: "ACTIVE", name: "Autoexpert Recalo OG", domicile: "Parndorf" }, "309");
  assert.deepEqual(s, { fnr: "612680a", name: "Autoexpert Recalo OG", sitz: "Parndorf", status: "ACTIVE", gericht: "Landesgericht Eisenstadt", bundesland: "Burgenland", legalForm: undefined });
  const d = trefferAt(
    { id: "56247t_17", fnr: "56247t", status: "DELETED", name: "Red Bull GmbH", domicile: null, legalForm: { abbr: "GES", name: "Gesellschaft mit beschränkter Haftung" }, address: { zipCode: "5330", street: "Am Brunnen 1", city: "Fuschl am See" } },
    "569",
  );
  assert.equal(d.status, "CLOSED");
  assert.equal(d.sitz, "Fuschl am See");
  assert.equal(d.legalForm, "Gesellschaft mit beschränkter Haftung");
  assert.equal(d.gericht, "Landesgericht Salzburg");
});

test("Ediktsdatei: Ergebnisliste und Detailseite (Konkurs, Aufhebung mangels Kostendeckung)", () => {
  const liste = parseEdikteListe(fixture("edikte-fn-588123m.html"));
  assert.equal(liste.anzahl, 1);
  assert.deepEqual(liste.eintraege, [{ docId: "bd1061b3c2cf83acc1258d41007947a7", gericht: "HG Wien", aktenzeichen: "5 S 191/25k", schuldner: "ACS Bus und Flughafentransfer GmbH", ort: "1120 Wien" }]);

  const v = parseEdikteVerfahren(fixture("edikte-detail-588123m.html"), liste.eintraege[0].docId);
  assert.equal(v.gericht, "HG Wien");
  assert.equal(v.aktenzeichen, "5 S 191/25k");
  assert.equal(v.verfahren, "Konkursverfahren");
  assert.equal(v.fn, "588123m");
  assert.equal(companyIdAusVerfahren(v), "AT_FN588123M");
  assert.equal(v.abschnitte.length, 8);
  assert.equal(v.abschnitte[0].datumIso, "2025-11-13");
  assert.equal(v.abschnitte[0].felder[0][0], "Firmenbuchnummer");

  const m = meldungenAusVerfahren(v, "AT_FN588123M");
  assert.equal(m.length, 8);
  assert.deepEqual(
    m.map((x) => [x.datum, x.gegenstand]),
    [
      ["2025-11-13", "EROEFFNUNG"],
      ["2025-11-20", "SONSTIGES"],
      ["2026-02-09", "SONSTIGES"],
      ["2026-05-14", "SONSTIGES"],
      ["2026-06-26", "SONSTIGES"],
      ["2026-08-04", "SONSTIGES"],
      ["2026-08-24", "AUFHEBUNG"],
      ["2026-09-14", "SONSTIGES"],
    ],
  );
  assert.equal(m[0].quelle, "ediktsdatei");
  assert.equal(m[0].insolvenzgericht, "HG Wien");
  assert.match(m[0].text, /^Konkursverfahren\. Eröffnung: Beginn der Wirkungen der Eröffnung: 14\.11\.2025/);
  assert.ok(!/Masseverwalter/.test(m[0].text), "Personendaten des Verwalters nicht im Text");
});

test("Ediktsdatei: Privatperson ohne FN, Abweisung mangels Kostendeckung", () => {
  const v = parseEdikteVerfahren(fixture("edikte-detail-kostendeckung.html"), "7864794784ef83edc1258e6b0073b2dc");
  assert.equal(v.fn, null);
  assert.equal(v.verfahren, "Konkurseröffnungsverfahren");
  assert.equal(kategorieAt(v.abschnitte[0].felder), "ABWEISUNG_MANGELS_MASSE");
  assert.equal(datumLang("Bekannt gemacht am 3. Jänner 2026"), "2026-01-03");
  assert.equal(datumLang("kein Datum"), null);
});

test("JustizOnlineClient: 429 einmal mit Retry-After wiederholen, zweites 429 = gesperrt", async () => {
  let n = 0;
  const antworten = [429, 429, 200];
  const client = new JustizOnlineClient({
    schlafen: async () => {},
    fetchImpl: (async () => {
      const st = antworten[n++];
      return { status: st, headers: new Headers({ "retry-after": "10" }), json: async () => ({ numResults: 1, companies: [{ id: "1a_1", fnr: "1a", status: "ACTIVE", name: "X", domicile: "Y" }] }) } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  const r = await client.suche("1a", 0, "309");
  assert.equal(r.gesperrt, true);
  assert.equal(n, 2);
  const r2 = await client.suche("1a", 0, "309");
  assert.equal(r2.gesperrt, false);
  assert.equal(r2.treffer.length, 1);
});

function atAttrappe(seiten: Record<string, Array<{ fnr: string; name: string }>>, edikte: Record<string, string[]> = {}) {
  const takt = new Taktgeber(100000, Date.now, async () => {});
  const aufrufe: string[] = [];
  return {
    aufrufe,
    at: {
      firmenbuch: {
        async suche(term: string, page: number) {
          aufrufe.push(`s:${term}:${page}`);
          const alle = seiten[term] ?? [];
          const t = alle.slice(page * 10, page * 10 + 10).map((x) => ({ id: `${x.fnr}_1`, fnr: x.fnr, status: "ACTIVE", name: x.name, domicile: "Wien" }));
          return { treffer: t, gesamt: alle.length, gesperrt: false };
        },
        async detail(fnr: string) {
          aufrufe.push(`d:${fnr}`);
          return { detail: { id: `${fnr}_2`, fnr, status: "ACTIVE", name: "Detail GmbH", domicile: "Graz", legalForm: { name: "GmbH" } }, gesperrt: false };
        },
      },
      edikte: {
        async fnSuche(fnr: string) {
          aufrufe.push(`e:${fnr}`);
          return { eintraege: (edikte[fnr] ?? []).map((d) => ({ docId: d, gericht: "HG Wien", aktenzeichen: "1 S 1/26a", schuldner: "X", ort: "Wien" })), gesperrt: false };
        },
        async verfahren(docId: string) {
          aufrufe.push(`v:${docId}`);
          return { verfahren: parseEdikteVerfahren(fixture("edikte-detail-588123m.html"), docId), gesperrt: false };
        },
      },
      taktFirmenbuch: takt,
      taktEdikte: takt,
    },
  };
}

const basisOpt = { workerId: "w1", portal: { suche: async () => { throw new Error("nicht noetig"); }, bekanntmachungenText: async () => { throw new Error("nicht noetig"); } }, takt: new Taktgeber(100000, Date.now, async () => {}) };

test("at_front: paginiert bis numResults, meldet fertig; Budget erschoepft → Fortsetzung", async () => {
  const seiten = { "0a": Array.from({ length: 23 }, (_, i) => ({ fnr: `${100 + i}0a`, name: `Firma ${i}` })) };
  const a = atAttrappe(seiten);
  const job = { id: "1", art: "at_front" as const, schluessel: "x", payload: { gerichtId: "007", begriff: "0a" }, prioritaet: 5, leaseUntil: null, versuche: 1, abfragenJeStunde: 1800 };
  const e = await fuehreJobAus(job, { ...basisOpt, at: a.at });
  assert.equal(e.abfragen, 3);
  assert.equal(e.trefferAt?.length, 23);
  assert.deepEqual(e.atFront, { begriff: "0a", naechsteSeite: 3, fertig: true, gesamt: 23 });
  assert.equal(e.trefferAt?.[0].gericht, "Handelsgericht Wien");

  const b = atAttrappe(seiten);
  const e2 = await fuehreJobAus(job, { ...basisOpt, at: b.at, maxAbfragenJeAtJob: 2 });
  assert.equal(e2.trefferAt?.length, 20);
  assert.deepEqual(e2.atFront, { begriff: "0a", naechsteSeite: 2, fertig: false, gesamt: 23 });
  const e3 = await fuehreJobAus({ ...job, payload: { gerichtId: "007", begriff: "0a", abSeite: 2 } }, { ...basisOpt, at: b.at });
  assert.equal(e3.trefferAt?.length, 3);
  assert.equal(e3.atFront?.fertig, true);
});

test("at_refresh: Detail je FN mit Rechtsform; at_insolvenz: nur Verfahren mit passender FN", async () => {
  const a = atAttrappe({}, { "588123m": ["bd1061b3c2cf83acc1258d41007947a7"], "1a": ["bd1061b3c2cf83acc1258d41007947a7"] });
  const r = await fuehreJobAus(
    { id: "2", art: "at_refresh", schluessel: "x", payload: { firmen: [{ companyId: "AT_FN1A", fnr: "1a", gerichtId: "638" }] }, prioritaet: 3, leaseUntil: null, versuche: 1, abfragenJeStunde: 1800 },
    { ...basisOpt, at: a.at },
  );
  assert.equal(r.abfragen, 2);
  assert.deepEqual(r.trefferAt, [{ fnr: "1a", name: "Detail GmbH", sitz: "Graz", status: "ACTIVE", gericht: "Landesgericht für ZRS Graz", bundesland: "Steiermark", legalForm: "GmbH" }]);

  const i = await fuehreJobAus(
    { id: "3", art: "at_insolvenz", schluessel: "x", payload: { firmen: [{ companyId: "AT_FN588123M", fnr: "588123m" }, { companyId: "AT_FN1A", fnr: "1a" }] }, prioritaet: 2, leaseUntil: null, versuche: 1, abfragenJeStunde: 3600 },
    { ...basisOpt, at: a.at },
  );
  assert.equal(i.insolvenz?.geprueft.length, 2);
  // Das Verfahren gehoert zu 588123m; fuer 1a liefert die Attrappe dasselbe Dokument, dessen FN nicht passt → keine Meldung.
  assert.equal(i.insolvenz?.meldungen.length, 8);
  assert.ok(i.insolvenz?.meldungen.every((m) => m.companyId === "AT_FN588123M" && m.quelle === "ediktsdatei"));
  assert.equal(i.abfragen, 4);
});
