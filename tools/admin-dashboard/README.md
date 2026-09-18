# AVA Betreiber-Dashboard

Ein kleines lokales Dashboard über alles, was die Nutzer verarbeiten: neue
Registerinhalte, Verarbeitungen über alle Producer hinweg, Organisationen und
ihr Tokenverbrauch, der Firmenbestand.

Es läuft ausschließlich auf deinem Rechner. Es gehört nicht zur App und wird
nicht ausgeliefert.

## Start

1. **Proxy zur Produktionsdatenbank öffnen** (eigenes Terminal, bleibt offen):

   ```bash
   nohup ~/.fly/bin/fly mpg proxy kyzl60xw8qlrpj9g > /tmp/mpg-proxy.log 2>&1 &
   ```

   Der Proxy horcht auf `localhost:16380`.

2. **Abhängigkeiten einmalig installieren:**

   ```bash
   cd tools/admin-dashboard && npm install
   ```

3. **Starten:**

   ```bash
   AVA_DB_PASSWORD='…' npm start --prefix tools/admin-dashboard
   ```

   Dann http://127.0.0.1:4300 öffnen.

## Umgebung

| Variable | Voreinstellung | Bedeutung |
| --- | --- | --- |
| `AVA_DB_PASSWORD` | – | Pflicht. Passwort des Datenbankbenutzers. |
| `AVA_DB_HOST` | `localhost` | Host des Proxys. |
| `AVA_DB_PORT` | `16380` | Port des Proxys. |
| `AVA_DB_USER` | `fly-user` | Datenbankbenutzer. |
| `AVA_DASHBOARD_PORT` | `4300` | Port des Dashboards. |
| `AVA_DASHBOARD_TIMEOUT_MS` | `150000` | Zeitgrenze je Abfrage. |
| `AVA_DASHBOARD_CACHE_MS` | `600000` | Wie lange ein Ergebnis wiederverwendet wird. |

Das Passwort steht bewusst nicht im Code und nicht in einer Datei hier.

## Sicherheit

Der Rahmen ist eng gezogen, weil das Werkzeug an der Produktionsdatenbank hängt:

* Der Server horcht nur auf `127.0.0.1`, ist also von außen nicht erreichbar.
* Jede Abfrage läuft in einer Transaktion mit `SET TRANSACTION READ ONLY`. Ein
  Schreibversuch scheitert an der Datenbank selbst, nicht erst an unserer
  Sorgfalt.
* SQL kommt nie von außen. Die Oberfläche nennt nur den **Namen** einer
  Kennzahl aus `abfragen.mjs`.
* Jede Abfrage hat eine Zeitgrenze (`statement_timeout`), damit eine schwere
  Aggregation über den Firmenbestand keine Verbindung blockiert.
* Je Datenbank höchstens zwei Verbindungen: das Cluster teilt sich 100.

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `abfragen.mjs` | Alle Kennzahlen als benannte SELECTs, je einer Datenbank zugeordnet. |
| `server.mjs` | HTTP-Server, Verbindungspools, Nur-Lese-Ausführung. |
| `public/index.html` | Oberfläche: Zeitraumwahl, Kacheln, Tabellen, Diagramme. |

### Eine Kennzahl ergänzen

In `abfragen.mjs` einen Eintrag hinzufügen:

```js
meine_kennzahl: {
  titel: "Sprechender Titel",
  db: "gateway",              // Schlüssel aus DATENBANKEN
  art: "tabelle",             // tabelle | verlauf | kennzahlen
  sql: `SELECT … WHERE "createdAt" > now() - ($1 || ' days')::interval`,
},
```

`$1` ist immer der Zeitraum in Tagen, auch wenn die Abfrage ihn nicht braucht.
Danach in `public/index.html` in `laden()` ein Gerüst und einen `kachel(…)`-Aufruf
ergänzen. `art: "verlauf"` erwartet zwei Spalten: Tag und Zahl.

## Laden und Wartezeiten

Die Seite baut zuerst ihr Gerüst auf und füllt dann jede Kachel einzeln über
`/api/kennzahlen`. Das ist Absicht: der Firmenbestand hat über fünf Millionen
Zeilen, eine gemeinsame Anfrage hätte die Seite je nach Zeitraum eine halbe
Minute lang leer stehen lassen.

Zwei Kacheln sind trotzdem langsam, weil sie den gesamten Firmenbestand
aggregieren müssen: „Firmenbestand nach Land" und „Neue Firmen je Tag" brauchen
beim ersten Aufruf rund 40 Sekunden. Der Server merkt sich jedes Ergebnis
zehn Minuten lang (`AVA_DASHBOARD_CACHE_MS`), danach ist die Seite sofort da.
Fragt die Oberfläche eine noch laufende Abfrage erneut an, hängt sie sich an
die laufende an, statt sie ein zweites Mal zu stellen.

Dauerhaft schneller würde es nur ein Index auf `GermanCompany(country)` machen.
Das ist ein Schreibzugriff auf die Produktionsdatenbank und daher bewusst nicht
Teil dieses Werkzeugs.
