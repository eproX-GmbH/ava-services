// Betreiber-Dashboard: kleiner lokaler Server, der die Kennzahlen aus
// abfragen.mjs liefert.
//
// Sicherheitsrahmen, bewusst eng:
//
//   - Nur auf 127.0.0.1. Der Server ist von außen nicht erreichbar.
//   - Nur lesend. Jede Abfrage läuft in einer Transaktion mit
//     `SET TRANSACTION READ ONLY`; ein Schreibversuch scheitert damit an der
//     Datenbank, nicht erst an unserer Sorgfalt.
//   - Keine frei übergebbaren Abfragen. Die Oberfläche nennt nur den Namen
//     einer Kennzahl aus abfragen.mjs; SQL kommt nie von außen.
//   - Zugangsdaten stehen nicht im Code, sondern in der Umgebung.
//
// Start: siehe README.md in diesem Verzeichnis.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ABDECKUNG, ABFRAGEN, DATENBANKEN } from "./abfragen.mjs";

const hier = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AVA_DASHBOARD_PORT ?? 4300);
const HOST = "127.0.0.1";

const ZUGANG = {
  host: process.env.AVA_DB_HOST ?? "localhost",
  port: Number(process.env.AVA_DB_PORT ?? 16380),
  user: process.env.AVA_DB_USER ?? "fly-user",
  password: process.env.AVA_DB_PASSWORD ?? "",
};

/** Ein Pool je Datenbank, klein gehalten: das Cluster teilt sich 100 Verbindungen. */
const pools = new Map();
function pool(kuerzel) {
  const datenbank = DATENBANKEN[kuerzel];
  if (!datenbank) throw new Error(`unbekannte Datenbank: ${kuerzel}`);
  let p = pools.get(kuerzel);
  if (!p) {
    p = new pg.Pool({ ...ZUGANG, database: datenbank, max: 2, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8_000 });
    p.on("error", () => {});
    pools.set(kuerzel, p);
  }
  return p;
}

/** Hoechstdauer je Abfrage. Manche Kennzahlen laufen ueber Millionen Zeilen
 *  (der Firmenbestand hat 5,2 Mio); ohne Grenze haengt die Seite. */
const ABFRAGE_FRIST_MS = Number(process.env.AVA_DASHBOARD_TIMEOUT_MS ?? 150_000);

/** Ergebnisspeicher. Die Bestandszahlen aggregieren ueber 5,2 Mio Zeilen und
 *  brauchen dafuer ueber vierzig Sekunden; sie aendern sich aber nur langsam.
 *  Ohne diesen Speicher wuerde jedes Aktualisieren die Wartezeit wiederholen. */
const SPEICHER_MS = Number(process.env.AVA_DASHBOARD_CACHE_MS ?? 10 * 60_000);
const speicher = new Map();

async function ausSpeicher(schluessel, holen) {
  const eintrag = speicher.get(schluessel);
  if (eintrag && Date.now() - eintrag.zeit < SPEICHER_MS) return { ...eintrag.wert, aus_speicher: eintrag.zeit };
  // Laeuft dieselbe Abfrage schon, warten wir auf sie, statt sie zweimal zu stellen.
  if (eintrag?.laufend) return await eintrag.laufend;
  const laufend = holen().then(
    (wert) => {
      speicher.set(schluessel, { zeit: Date.now(), wert });
      return wert;
    },
    (err) => {
      speicher.delete(schluessel);
      throw err;
    },
  );
  speicher.set(schluessel, { laufend });
  return await laufend;
}

/** Führt eine Abfrage streng lesend und mit Zeitgrenze aus. */
async function lies(kuerzel, sql, werte) {
  const verbindung = await pool(kuerzel).connect();
  try {
    await verbindung.query("BEGIN");
    await verbindung.query("SET TRANSACTION READ ONLY");
    await verbindung.query(`SET LOCAL statement_timeout = ${Math.round(ABFRAGE_FRIST_MS)}`);
    const r = await verbindung.query(sql, werte);
    await verbindung.query("COMMIT");
    return r.rows;
  } catch (err) {
    await verbindung.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    verbindung.release();
  }
}

function json(res, code, daten) {
  const text = JSON.stringify(daten);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

/** Verständliche Meldung statt eines Stapelauszugs. */
function fehlertext(err) {
  const m = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED|connect ETIMEDOUT/i.test(m)) {
    return "Keine Verbindung zur Datenbank. Läuft der Proxy? Siehe README in diesem Verzeichnis.";
  }
  if (/password authentication failed|no password supplied/i.test(m)) {
    return "Zugangsdaten stimmen nicht. AVA_DB_PASSWORD gesetzt?";
  }
  if (/statement timeout|canceling statement/i.test(m)) {
    return "Die Abfrage hat zu lange gedauert und wurde abgebrochen. Ein kleinerer Zeitraum hilft meist.";
  }
  return m;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  try {
    if (url.pathname === "/api/kennzahlen") {
      const name = url.searchParams.get("name") ?? "";
      const tage = Math.min(Math.max(Number(url.searchParams.get("tage") ?? 30) || 30, 1), 365);
      const abfrage = ABFRAGEN[name];
      if (!abfrage) return json(res, 404, { fehler: `unbekannte Kennzahl: ${name}` });
      const antwort = await ausSpeicher(`${name}:${tage}`, async () => ({
        name,
        titel: abfrage.titel,
        art: abfrage.art,
        zeilen: await lies(abfrage.db, abfrage.sql, [String(tage)]),
      }));
      return json(res, 200, antwort);
    }

    if (url.pathname === "/api/abdeckung") {
      const antwort = await ausSpeicher("abdeckung", async () => {
        const zeilen = [];
        for (const e of ABDECKUNG) {
          try {
            const [zeile] = await lies(e.db, e.sql, []);
            zeilen.push({ name: e.name, firmen: Number(zeile?.n ?? 0) });
          } catch {
            zeilen.push({ name: e.name, firmen: null });
          }
        }
        return { zeilen };
      });
      return json(res, 200, antwort);
    }

    // Statische Dateien
    const datei = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    if (datei.includes("..")) return json(res, 400, { fehler: "ungültiger Pfad" });
    const inhalt = await readFile(join(hier, "public", datei));
    const typ = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" }[extname(datei)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": typ });
    res.end(inhalt);
  } catch (err) {
    if (err?.code === "ENOENT") return json(res, 404, { fehler: "nicht gefunden" });
    json(res, 500, { fehler: fehlertext(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AVA-Betreiber-Dashboard: http://${HOST}:${PORT}`);
  if (!ZUGANG.password) {
    console.log("Hinweis: AVA_DB_PASSWORD ist nicht gesetzt — die Abfragen werden scheitern.");
  }
});
