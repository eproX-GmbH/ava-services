import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { erkenneArt, pruefeDokument } from "./dokument";

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, "..", "src", "fixtures", n));

test("Magic Bytes: PDF, TIFF, ZIP, sonst nichts", () => {
  assert.equal(erkenneArt(fixture("gesellschafter-eprox.pdf")), "pdf");
  assert.equal(erkenneArt(fixture("gesellschafter-tc85.zip")), "zip");
  assert.equal(erkenneArt(Buffer.from("MM\0*12345678")), "tiff");
  assert.equal(erkenneArt(Buffer.from("<html><body>Fehler</body></html>")), null);
  assert.equal(erkenneArt(Buffer.from("#!/bin/sh\necho x")), null);
});

test("pruefeDokument: PDF direkt, TIFF aus ZIP, Muell abgelehnt", async () => {
  const pdf = await pruefeDokument(fixture("gesellschafter-eprox.pdf"), "liste.pdf");
  assert.equal(pdf.art, "pdf");
  assert.equal(pdf.mime, "application/pdf");
  assert.match(pdf.sha256, /^[a-f0-9]{64}$/);
  const tiff = await pruefeDokument(fixture("gesellschafter-tc85.zip"), "liste.zip");
  assert.equal(tiff.art, "tiff");
  assert.equal(tiff.dateiname, "32657_HRB9501_GEL_S_2019-10-24_53404530_95892.tiff");
  assert.ok(tiff.bytes.length > 50_000);
  await assert.rejects(pruefeDokument(Buffer.from("<html>"), "x.pdf"), /unerwarteter Dateityp/);
  await assert.rejects(pruefeDokument(Buffer.alloc(0), "x.pdf"), /leere Datei/);
  await assert.rejects(pruefeDokument(Buffer.alloc(21 * 1024 * 1024, 1), "x.pdf"), /zu gross/);
});
