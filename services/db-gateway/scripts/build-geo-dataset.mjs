// Phase 0 Firmen-Discovery — Generator fuer src/data/geo-places.json.
//
// Laedt die GeoNames-PLZ-Datensaetze fuer DE, AT und GB (CC-BY 4.0,
// https://download.geonames.org/export/zip/) und destilliert ihn zu einem
// kompakten, eingecheckten Seed fuer die GeoPlace-Tabelle im Gateway.
//
// Filter-Regel (empirisch verifiziert 2026-08-29): Zeilen OHNE
// accuracy-Feld (Spalte 12) sind Grosskunden-/Firmen-PLZ (Ortsname =
// Firmenname, Bundesland auf Englisch) — die fliegen raus. Uebrig
// bleiben ~15k echte (PLZ, Ort)-Zeilen mit Koordinaten.
//
// Aufruf (einmalig / bei Daten-Refresh, ~jaehrlich):
//   node scripts/build-geo-dataset.mjs
//
// Schreibt src/data/geo-places.json als { meta, rows } mit
// rows: [country, name, plz, bundesland, kreis, agsKreis, lat, lon][].

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "data",
  "geo-places.json",
);

// DE.zip entpacken ohne Fremd-Dependency: DE.txt ist "stored" oder
// "deflated" — wir nutzen das zentrale Verzeichnis nicht, sondern den
// Local-File-Header des DE.txt-Eintrags.
import { inflateRawSync } from "node:zlib";
function extractEntry(buf, wantedName) {
  // End-of-Central-Directory suchen (von hinten), dann das zentrale
  // Verzeichnis lesen — Local Header koennen Data-Descriptors nutzen
  // (Groessen 0), das zentrale Verzeichnis ist immer verlaesslich.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Zip: EOCD nicht gefunden");
  let off = buf.readUInt32LE(eocd + 16);
  while (off + 46 <= buf.length && buf.readUInt32LE(off) === 0x02014b50) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (name === wantedName) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      return method === 0 ? data : inflateRawSync(data);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wantedName} nicht im Zip gefunden`);
}

// docs/PLAN_RADAR_LAENDER.md (R-L0): drei Laender in einem Seed. GeoNames
// fuehrt UK als "GB"; AVA nennt das Land "UK" (master-data country).
// Fuer GB nimmt GeoNames GB.zip = Outward-Codes (~27k Zeilen), nicht
// GB_full (1,7 Mio.). Der accuracy-Filter gilt nur fuer DE (Grosskunden-PLZ).
const LAENDER = [
  { ava: "DE", geonames: "DE", accuracyPflicht: true },
  { ava: "AT", geonames: "AT", accuracyPflicht: false },
  { ava: "UK", geonames: "GB", accuracyPflicht: false },
];
const rows = [];
let dropped = 0;
for (const land of LAENDER) {
  const res = await fetch(`https://download.geonames.org/export/zip/${land.geonames}.zip`);
  if (!res.ok) throw new Error(`GeoNames-Download ${land.geonames} fehlgeschlagen: ${res.status}`);
  const zipBuf = Buffer.from(await res.arrayBuffer());
  const txt = extractEntry(zipBuf, `${land.geonames}.txt`).toString("utf8");
  let n = 0;
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    // f: [0]=land [1]=plz [2]=ort [3]=admin1 [4]=code1 [5]=admin2 [6]=code2
    //    [7]=admin3 [8]=code3 [9]=lat [10]=lon [11]=accuracy
    // DE: admin1=Bundesland, admin3=Kreis, code3=AGS-Kreis.
    // AT: admin1=Bundesland, admin2=Bezirk. UK: admin1=Landesteil, admin2=County/Region.
    const accuracy = (f[11] ?? "").trim();
    if (land.accuracyPflicht && !accuracy) {
      dropped++;
      continue;
    }
    const lat = Number(f[9]);
    const lon = Number(f[10]);
    if (!f[1] || !f[2] || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      dropped++;
      continue;
    }
    const kreis = land.ava === "DE" ? (f[7] ?? "").trim() : ((f[5] ?? "").trim() || (f[7] ?? "").trim());
    const kreisCode = land.ava === "DE" ? (f[8] ?? "").trim() : ((f[6] ?? "").trim() || (f[8] ?? "").trim());
    rows.push([
      land.ava,
      f[2].trim(),
      f[1].trim(),
      (f[3] ?? "").trim(),
      kreis,
      kreisCode,
      Math.round(lat * 10000) / 10000,
      Math.round(lon * 10000) / 10000,
    ]);
    n++;
  }
  console.log(`${land.ava}: ${n} Zeilen`);
}

const out = {
  meta: {
    source: "GeoNames postal codes DE, AT, GB (https://download.geonames.org/export/zip/)",
    license: "CC-BY 4.0 — Attribution: GeoNames (geonames.org)",
    generatedAt: new Date().toISOString().slice(0, 10),
    columns: ["country", "name", "plz", "bundesland", "kreis", "agsKreis", "lat", "lon"],
    rowCount: rows.length,
  },
  rows,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log(`geschrieben: ${OUT} — ${rows.length} Zeilen (${dropped} verworfen)`);
