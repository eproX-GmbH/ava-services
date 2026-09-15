import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { companyIdUk, registrarUk, titel, bulkZeileZuTreffer, parseCsvStream, parseBulkSeite, parseFirmaUk, firmaZuTreffer, parseInsolvenzUk, meldungenAusFaellen, parseGazetteFeed, meldungenAusGazette, kategorieGazette, CompaniesHouseClient } from "./uk-companies-house";
import { fuehreJobAus } from "./jobs";
import { Taktgeber } from "./takt";

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, "..", "src", "fixtures", n), "utf8");
const fixturePfad = (n: string) => path.join(__dirname, "..", "src", "fixtures", n);

test("companyIdUk: 8 Zeichen mit Praefix, Suffix und fuehrenden Nullen", () => {
  assert.equal(companyIdUk("00077570"), "UK_00077570");
  assert.equal(companyIdUk("77570"), "UK_00077570");
  assert.equal(companyIdUk("sc123456"), "UK_SC123456");
  assert.equal(companyIdUk("IP12345R"), "UK_IP12345R");
  assert.throws(() => companyIdUk("SC1234567"));
  assert.throws(() => companyIdUk("ABC"));
  assert.deepEqual(registrarUk("SC123456"), { behoerde: "Companies House Edinburgh", landesteil: "Scotland" });
  assert.deepEqual(registrarUk("NI012345"), { behoerde: "Companies House Belfast", landesteil: "Northern Ireland" });
  assert.equal(registrarUk("00077570").behoerde, "Companies House Cardiff");
  assert.equal(titel("LYTHAM ST ANNES"), "Lytham St Annes");
});

test("Bulk-CSV: Streaming-Parser und Abbildung (Status, Insolvenz, SIC, fruehere Namen, Adresse)", async () => {
  const zeilen: Record<string, string>[] = [];
  const n = await parseCsvStream(Readable.from([fixture("ch-bulk-probe.csv")]), (z) => {
    zeilen.push(z);
  });
  assert.equal(n, zeilen.length);
  assert.ok(n >= 40);
  const treffer = zeilen.map(bulkZeileZuTreffer).filter((t): t is NonNullable<typeof t> => t !== null);
  assert.equal(treffer.length, n);
  const liq = treffer.find((t) => t.insolvenz === "EROEFFNET");
  assert.ok(liq, "Liquidation in der Probe");
  assert.equal(liq.status, "ACTIVE");
  const sc = treffer.find((t) => t.nummer.startsWith("SC"));
  assert.ok(sc && sc.landesteil === "Scotland" && sc.behoerde === "Companies House Edinburgh");
  const mitNamen = treffer.find((t) => (t.fruehereNamen?.length ?? 0) >= 2);
  assert.ok(mitNamen, "fruehere Namen in der Probe");
  const erste = treffer[0];
  assert.match(erste.zipCode ?? "", /^[A-Z]/);
  assert.match(erste.incorporatedAt ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(erste.sicCodes && erste.sicCodes.every((c) => /^\d{4,5}$/.test(c)));
  assert.equal(erste.legalForm, "Private Limited Company");
  // Anfuehrungszeichen mit Komma im Feld
  const q: Record<string, string>[] = [];
  await parseCsvStream(Readable.from(['a,b\n"x, y","sagt ""hi"""\n']), (z) => {
    q.push(z);
  });
  assert.deepEqual(q, [{ a: "x, y", b: 'sagt "hi"' }]);
});

test("Download-Seite → Teil-Dateien", () => {
  const teile = parseBulkSeite(fixture("ch-download-seite.html"));
  assert.equal(teile.length, 7);
  assert.deepEqual(teile[0], { url: "https://download.companieshouse.gov.uk/BasicCompanyData-2026-09-01-part1_7.zip", datum: "2026-09-01", teil: 1, teile: 7 });
});

test("CompaniesHouseClient.bulkTeilLesen: ZIP auf Platte streamen", async () => {
  const client = new CompaniesHouseClient({
    fetchImpl: (async (url: string) => {
      const buf = fs.readFileSync(fixturePfad("ch-bulk-probe.zip"));
      return new Response(buf, { status: 200 });
    }) as unknown as typeof fetch,
  });
  const gesehen: string[] = [];
  const n = await client.bulkTeilLesen("https://download.companieshouse.gov.uk/x.zip", (t) => {
    gesehen.push(t.nummer);
  });
  assert.equal(n, gesehen.length);
  assert.ok(n >= 40);
});

test("Firmenseite und Insolvenzseite (SODASTREAM LIMITED)", () => {
  const fi = parseFirmaUk(fixture("ch-company-00077570.html"), "00077570");
  assert.equal(fi.name, "SODASTREAM LIMITED");
  assert.equal(fi.status, "Liquidation");
  assert.equal(fi.gegruendet, "1903-05-30");
  assert.deepEqual(fi.sic, ["1598"]);
  const t = firmaZuTreffer(fi);
  assert.ok(t);
  assert.equal(t.insolvenz, "EROEFFNET");
  assert.equal(t.zipCode, "FY8 1LH");
  assert.equal(t.sitz, "Lancashire");
  assert.equal(t.street, "284 Clifton Drive South, St Annes Lytham St Annes");
  const faelle = parseInsolvenzUk(fixture("ch-insolvency-00077570.html"));
  assert.equal(faelle.length, 1);
  assert.equal(faelle[0].art, "Compulsory liquidation");
  assert.equal(faelle[0].daten["wound-up-on"], "8 February 2006");
  assert.deepEqual(faelle[0].verwalter, ["James Richard Duckworth", "The Official Receiver Or London"]);
  const m = meldungenAusFaellen(faelle, "UK_00077570");
  assert.deepEqual(
    m.map((x) => [x.datum, x.gegenstand, x.quelle]),
    [
      ["2006-02-08", "EROEFFNUNG", "companieshouse"],
      ["2012-03-15", "AUFHEBUNG", "companieshouse"],
    ],
  );
});

test("Gazette-Feed: nur Eintraege mit der Nummer, Kategorien", () => {
  const e = parseGazetteFeed(fixture("gazette-00077570.xml"), "00077570");
  assert.equal(e.length, 1);
  assert.equal(e[0].kategorie, "Winding-Up Orders");
  assert.equal(e[0].datum, "2006-02-20");
  const m = meldungenAusGazette(e, "UK_00077570");
  assert.equal(m[0].gegenstand, "EROEFFNUNG");
  assert.equal(m[0].quelle, "gazette");
  assert.equal(kategorieGazette("Petitions to Wind Up (Companies)", ""), "SONSTIGES");
  assert.equal(kategorieGazette("Notices of Dividends", ""), "VERTEILUNG");
  assert.equal(kategorieGazette("Appointment of Liquidators", ""), "EROEFFNUNG");
});

function ukAttrappe() {
  const takt = new Taktgeber(100000, Date.now, async () => {});
  const teile: Array<{ teil: number; n: number }> = [];
  const zeilen = fixture("ch-bulk-probe.csv");
  return {
    teile,
    uk: {
      companiesHouse: {
        async bulkTeile() {
          return parseBulkSeite(fixture("ch-download-seite.html"));
        },
        async bulkTeilLesen(_url: string, zeile: (t: NonNullable<ReturnType<typeof bulkZeileZuTreffer>>) => Promise<void> | void) {
          return parseCsvStream(Readable.from([zeilen]), async (z) => {
            const t = bulkZeileZuTreffer(z);
            if (t) await zeile(t);
          });
        },
        async firma(nummer: string) {
          return { firma: parseFirmaUk(fixture("ch-company-00077570.html"), nummer), gesperrt: false };
        },
        async insolvenz() {
          return { faelle: parseInsolvenzUk(fixture("ch-insolvency-00077570.html")), gesperrt: false };
        },
        async gazette() {
          return { eintraege: parseGazetteFeed(fixture("gazette-00077570.xml"), "00077570"), gesperrt: false };
        },
      },
      takt,
      teilergebnis: async (_jobId: string, teil: number, trefferUk: unknown[]) => {
        teile.push({ teil, n: trefferUk.length });
      },
    },
  };
}
const basisOpt = { workerId: "w1", portal: { suche: async () => { throw new Error("nicht noetig"); }, bekanntmachungenText: async () => { throw new Error("nicht noetig"); } }, takt: new Taktgeber(100000, Date.now, async () => {}) };

test("uk_bulk meldet Buendel als Teilergebnisse; uk_refresh und uk_insolvenz liefern Treffer und Meldungen", async () => {
  const a = ukAttrappe();
  const e = await fuehreJobAus(
    { id: "9", art: "uk_bulk", schluessel: "x", payload: { url: "u", datum: "2026-09-01", teil: 7, teile: 7 }, prioritaet: 5, leaseUntil: null, versuche: 1, abfragenJeStunde: 1800 },
    { ...basisOpt, uk: a.uk },
  );
  assert.equal(a.teile.length, 1);
  assert.equal(e.ukBulk?.zeilen, a.teile[0].n);
  assert.equal(e.ukBulk?.teilergebnisse, 1);

  const r = await fuehreJobAus(
    { id: "10", art: "uk_refresh", schluessel: "x", payload: { firmen: [{ companyId: "UK_00077570", nummer: "00077570" }] }, prioritaet: 3, leaseUntil: null, versuche: 1, abfragenJeStunde: 1800 },
    { ...basisOpt, uk: a.uk },
  );
  assert.equal(r.trefferUk?.length, 1);
  assert.equal(r.trefferUk?.[0].insolvenz, "EROEFFNET");

  const i = await fuehreJobAus(
    { id: "11", art: "uk_insolvenz", schluessel: "x", payload: { firmen: [{ companyId: "UK_00077570", nummer: "00077570" }, { companyId: "UK_FALSCH", nummer: "1" }] }, prioritaet: 2, leaseUntil: null, versuche: 1, abfragenJeStunde: 1800 },
    { ...basisOpt, uk: a.uk },
  );
  assert.deepEqual(i.insolvenz?.geprueft, ["UK_00077570"]);
  assert.equal(i.insolvenz?.meldungen.length, 3);
  assert.equal(i.abfragen, 2);
});
