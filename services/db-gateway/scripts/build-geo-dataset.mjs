// Phase 0 Firmen-Discovery — Generator fuer src/data/geo-places.json.
//
// Laedt den GeoNames-PLZ-Datensatz fuer Deutschland (CC-BY 4.0,
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
// rows: [name, plz, bundesland, kreis, agsKreis, lat, lon][].

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

const res = await fetch("https://download.geonames.org/export/zip/DE.zip");
if (!res.ok) throw new Error(`GeoNames-Download fehlgeschlagen: ${res.status}`);
const zipBuf = Buffer.from(await res.arrayBuffer());

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

const txt = extractEntry(zipBuf, "DE.txt").toString("utf8");
const rows = [];
let dropped = 0;
for (const line of txt.split("\n")) {
  if (!line.trim()) continue;
  const f = line.split("\t");
  // f: [0]=DE [1]=plz [2]=ort [3]=bundesland [4]=code1 [5]=regbez
  //    [6]=code2 [7]=kreis [8]=agsKreis [9]=lat [10]=lon [11]=accuracy
  const accuracy = (f[11] ?? "").trim();
  if (!accuracy) {
    dropped++; // Grosskunden-PLZ (Firmenname statt Ort)
    continue;
  }
  const lat = Number(f[9]);
  const lon = Number(f[10]);
  if (!f[1] || !f[2] || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    dropped++;
    continue;
  }
  rows.push([
    f[2].trim(),
    f[1].trim(),
    (f[3] ?? "").trim(),
    (f[7] ?? "").trim(),
    (f[8] ?? "").trim(),
    Math.round(lat * 10000) / 10000,
    Math.round(lon * 10000) / 10000,
  ]);
}

const out = {
  meta: {
    source: "GeoNames postal codes DE (https://download.geonames.org/export/zip/)",
    license: "CC-BY 4.0 — Attribution: GeoNames (geonames.org)",
    generatedAt: new Date().toISOString().slice(0, 10),
    columns: ["name", "plz", "bundesland", "kreis", "agsKreis", "lat", "lon"],
    rowCount: rows.length,
  },
  rows,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log(`geschrieben: ${OUT} — ${rows.length} Zeilen (${dropped} verworfen)`);
