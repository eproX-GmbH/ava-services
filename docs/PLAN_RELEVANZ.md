# Plan: Relevanz — was fuer diesen Nutzer wirklich zaehlt

Stand 2026-09-20. Ziel: Aus dem Rauschen von 2000 Firmen und ihren
Kontakten das herausziehen, was fuer DIESEN Nutzer gerade zaehlt — und
die knappe Beobachtungszeit des Heartbeats dorthin lenken.

---

## 0. Meine Meinung vorweg

Die Richtung stimmt, und der Vergleich mit dem Microsoft Graph trifft den
Kern besser als ZoomInfos Champions: Champions sind eine Eigenschaft der
Person (kennt dich, wechselt, nimm Kontakt auf), der Graph ist eine
Eigenschaft der Beziehung zwischen Nutzer und Objekt. Genau das brauchen
wir, weil dieselbe Firma fuer zwei Nutzer derselben Organisation voellig
verschieden wichtig sein kann.

Drei Dinge wuerde ich aber anders setzen, als es der erste Impuls nahelegt:

**Erstens: Ein Score misst Aufmerksamkeit, nicht Wert.** Eine Firma, die
noch nie jemand angesehen hat, kann die wichtigste im Bestand sein — sie
ist nur noch nicht entdeckt. Wer den Heartbeat allein nach
Verhaltenssignalen steuert, baut eine Rueckkopplung: beobachtet wird, was
angesehen wurde; gemeldet wird, was beobachtet wurde; angesehen wird, was
gemeldet wurde. Nach vier Wochen hat AVA einen blinden Fleck, der genau so
gross ist wie der Teil des Bestands, den der Nutzer in der ersten Woche
nicht angeklickt hat. Deshalb schlage ich **zwei Groessen** vor, die
getrennt bleiben und erst am Ende zusammenkommen:

- **Naehe** (1–10): wie nah dran ist der Nutzer an dieser Firma/Person.
  Rein aus Verhalten. Das ist der "heiss/kalt"-Wert aus deiner Idee.
- **Gewicht** (1–10): wie gut passt die Firma sachlich — ICP-Treffer,
  Firmenstatus, Groesse, Pipeline-Stand, Watchlist-Fokus. Voellig ohne
  Verhalten.

Der Heartbeat priorisiert nach beiden, mit einer festen Reserve fuer
Firmen mit hohem Gewicht und niedriger Naehe. Das ist die
Entdeckungsspur, und sie ist nicht verhandelbar — ohne sie wird das
System blind fuer alles, was der Nutzer noch nicht kennt.

**Zweitens: Der Score darf die Alarmschwelle verschieben, nicht die
Alarmart erfinden.** Ein Positionswechsel bleibt ein Positionswechsel.
Was sich aendert, ist nur, ab welcher Naehe er den Weg bis zum Nutzer
findet: bei Naehe 9 sofort per Telegram, bei Naehe 5 gesammelt in der
Tageszusammenfassung, bei Naehe 2 gar nicht (nur im Datensatz). Das haelt
den Alert-Judge einfach und macht das Verhalten erklaerbar. Der Umkehrweg
— der Score erzeugt eigene Alarmarten — waere schwer zu begruenden und
noch schwerer abzuschalten.

**Drittens: Das ist eine Verhaltenserfassung von Beschaeftigten.** In
einer Organisation mit Betriebsrat ist "wir zeichnen auf, welche Firmen
Mitarbeiter X ansieht" mitbestimmungspflichtig, unabhaengig davon, wie
gut es gemeint ist. Entsprechend: Die Rohsignale bleiben **lokal auf dem
Geraet des Nutzers** und werden **nie** an den Server oder an andere
Mitglieder der Organisation uebertragen. Was die Organisation hoechstens
sieht, ist ein anonymer Aggregatwert, und auch der nur, wenn die
Organisation ihn ausdruecklich einschaltet. Das ist keine Vorsicht aus
Prinzip, sondern die Bedingung dafuer, dass die Funktion in einem
Unternehmen ueberhaupt eingeschaltet bleiben darf. Es passt ausserdem
exakt zur bestehenden Rechenlokalitaet: Der Nutzer rechnet alles auf
seiner Maschine.

Eine vierte, kleinere Meinung: **Nicht jedes Signal ist gleich viel wert,
und die teuersten Signale sind die besten.** Eine Firmenansicht kostet
einen Klick. Einen DSGVO-Hinweis kopieren, einen Kontakt ins CRM
uebernehmen, eine Firma in einen Workflow geben — das kostet Arbeit und
Absicht. Solche Signale sollten das Vielfache einer Ansicht wiegen und
langsamer verfallen. Ein Score, der im Wesentlichen "oft geklickt"
bedeutet, ist ein Score fuer unentschlossene Nutzer.

---

## 1. Was es dafuer schon gibt

Ueberraschend viel. Der Plan baut zum grossen Teil aus, was vorhanden ist.

| Baustein | Wo | Was er heute tut |
| --- | --- | --- |
| `InterestStore` | `main/agent/interest-store.ts` | Ringpuffer ueber 200 Firmen im Arbeitsspeicher, gefuettert aus zwei Stellen: Oeffnen der Firmen-Detailansicht (`CompanyDetail.tsx`) und Klick auf einen Firmenlink im Chat (`Chat.tsx`). Lineare Abnahme ueber 14 Tage. |
| Frischeplaner | `main/agent/freshness-scheduler.ts` | Liest `getBoost()` und verdoppelt damit die Punktzahl einer heute angesehenen Firma. |
| Heartbeat | `main/agent/heartbeat.ts` | Alle 15 Minuten (mit Streuung), einzeln laufend, holt Kandidaten vom Gateway, laesst den Alert-Judge urteilen. |
| Alert-Judge | `main/agent/alert-judge.ts` | Ein LLM-Aufruf je Kandidat, JSON per yup geprueft, liefert `worthAlerting`, `severity`, `headline`, `rationale`. |
| Alarmarten | `shared/types.ts` | 12 `AlertKind`, drei Stufen `info` / `warn` / `urgent`, Push erst ab `severityThreshold`. |
| Watchlist-Fokus | `main/linkedin/watchlist/store.ts` | Manuelles Fokus-Kennzeichen mit Obergrenze; Fokus-Eintraege werden zuerst abgearbeitet. |
| ICP / Radar | ICP-Store, Firmenradar | Sachliche Passungsbewertung, vollstaendig lokal. |
| Kontaktrang | Contact-Producer | Vier Stufen (Leitung / Bereich / Fach / sonstige) je Kontakt. |
| Lokale Speicher | `linkedin/db.ts`, `mail/store.ts`, `usage/usage-store.ts` … | PGlite je Bereich, Schema als `CREATE TABLE IF NOT EXISTS` beim ersten Zugriff. Kein Migrationslaeufer. |

Was fehlt: Der `InterestStore` ueberlebt keinen Neustart, kennt nur
Firmen (keine Personen), kennt nur zwei Signalarten, wiegt alle gleich
und wirkt nur auf den Frischeplaner. Genau diese fuenf Luecken schliesst
dieser Plan.

---

## 2. Zielbild

Fuer jedes Paar (Nutzer, Firma) und (Nutzer, Person) fuehrt AVA lokal:

```
Naehe    1..10   aus Verhalten, mit Halbwertszeit
Gewicht  1..10   aus Sachkriterien, ohne Verhalten
Rang             die Reihenfolge, in der der Heartbeat arbeitet
Schwelle         ab welcher Stufe ein Fund den Nutzer erreicht
```

Sichtbar wird das an drei Stellen: als Waermeanzeige in der
Firmenansicht (mit Begruendung), als Reihenfolge der
Heartbeat-Beobachtung, und als Filter darueber, welche Funde als Alarm
durchkommen.

---

## 3. Signalkatalog

Gewichte als Grundpunkte je Ereignis. Die Zahlen sind ein Vorschlag zum
Nachjustieren, kein Naturgesetz — Abschnitt 12 nennt sie als offene
Entscheidung. Halbwertszeit heisst: nach dieser Zeit wiegt das Ereignis
noch die Haelfte.

### 3.1 Firmensignale

| Signal | Punkte | Halbwertszeit | Woher |
| --- | --- | --- | --- |
| Firmen-Detailansicht geoeffnet | 3 | 21 Tage | `CompanyDetail` (gibt es schon) |
| Verweildauer > 30 s in der Ansicht | +2 | 21 Tage | Sichtbarkeits-Zeitmessung, einmal je Sitzung |
| Firmenlink im Chat geklickt | 3 | 21 Tage | `Chat.tsx` (gibt es schon) |
| Firma im Chat erwaehnt (Nutzertext) | 5 | 30 Tage | Chat-Nachverarbeitung, siehe 3.4 |
| Firma in "Meine Firmen" uebernommen | 12 | 120 Tage | Uebernehmen-Knopf |
| Import fuer die Firma gestartet | 10 | 90 Tage | Import-Knopf |
| Firma in einen Workflow gegeben | 14 | 120 Tage | Workflow-Start |
| Firma auf die Watchlist / Fokus | 18 | kein Verfall, solange gesetzt | Watchlist |
| Kontakt der Firma ins CRM uebernommen | 16 | 120 Tage | CRM-Tools |
| Alarm zu dieser Firma geoeffnet | 4 | 30 Tage | Alarmliste |
| Alarm zu dieser Firma weggewischt | **-3** | 30 Tage | Alarmliste |
| Firma aus der Uebersicht entfernt | **Naehe auf 1, Sperre 90 Tage** | — | Loeschknopf |

Die beiden negativen Eintraege sind mir wichtig. Ein System, das nur
addiert, kann sich nicht korrigieren; wer dreimal denselben Alarm
wegwischt, sagt damit sehr deutlich etwas, und AVA sollte zuhoeren.

### 3.2 Personensignale

Personen erben die halbe Naehe ihrer Firma als Untergrenze — wer eine
Firma heiss findet, findet ihre Geschaeftsfuehrung nicht kalt. Darauf
kommt Eigenes:

| Signal | Punkte | Halbwertszeit |
| --- | --- | --- |
| Profiladresse geoeffnet (LinkedIn/Xing) | 6 | 60 Tage |
| DSGVO-Hinweis zu dieser Person kopiert | 14 | 180 Tage |
| Person ins CRM uebernommen | 18 | 180 Tage |
| E-Mail-Adresse kopiert / Mailentwurf begonnen | 10 | 90 Tage |
| Person in der Kontaktsuche gefunden und geoeffnet | 4 | 45 Tage |
| Person namentlich im Chat erwaehnt | 8 | 60 Tage |
| Person auf die Personen-Watchlist | 18 | kein Verfall |

Der DSGVO-Hinweis steht bewusst so hoch: Wer ihn kopiert, schreibt diese
Person an. Ein ehrlicheres Absichtssignal gibt es in AVA nicht.

### 3.3 Was **kein** Signal ist

Damit die Erfassung nachvollziehbar bleibt und sich nicht zum
Bildschirmprotokoll auswaechst, wird ausdruecklich nicht erfasst:

- Mausbewegungen, Bildlauf, Tastenanschlaege, Verweildauer je Abschnitt.
- Chat-Inhalte im Wortlaut. Erfasst wird nur "Firma X kam vor", nie der Satz.
- Ergebnisse von Listenansichten. Wer eine Liste mit 200 Firmen
  oeffnet, hat nicht 200-mal Interesse gezeigt. Nur der Sprung in die
  Detailansicht zaehlt.
- Alles, was der Heartbeat selbst tut. Automatik darf sich nicht selbst
  interessant finden — sonst laeuft der Score hoch, ohne dass ein Mensch
  je hingesehen hat.

### 3.4 Firmen im Chat erkennen

Ohne eigenen LLM-Aufruf, aus zwei Quellen:

1. **Firmenlinks** `[Name](company:ID)` im Chatverlauf — eindeutige
   Zuordnung, kostenlos, deckt alles ab, was AVA selbst genannt hat.
2. **Werkzeugaufrufe** der laufenden Antwort: Jedes Tool, das mit einer
   `companyId` oder `personId` arbeitet, meldet sie mit. Damit zaehlt
   auch, wonach der Nutzer gefragt hat, ohne dass irgendjemand den
   Fliesstext durchsuchen muss.

Freitext-Erkennung ("die Zimmer aus Rheinau") bleibt bewusst aussen vor:
ein unscharfer Abgleich gegen 2000 Firmennamen produziert genau die
falschen Treffer, die das Ranking spaeter unerklaerlich machen.

---

## 4. Datenmodell (lokal, PGlite)

Neuer Speicher `main/relevanz/` nach dem Muster von
`main/linkedin/db.ts`: eigene PGlite-Instanz unter
`userData/relevanz/db/`, Schema als `CREATE TABLE IF NOT EXISTS` beim
ersten Zugriff, kein Migrationslaeufer, nur Hauptprozess, Renderer
ausschliesslich ueber IPC.

```sql
CREATE TABLE IF NOT EXISTS signal (
  id          BIGSERIAL PRIMARY KEY,
  ziel_art    TEXT        NOT NULL,   -- 'firma' | 'person'
  ziel_id     TEXT        NOT NULL,
  firma_id    TEXT,                   -- bei Personen: Firma, ueber die sie kam
  art         TEXT        NOT NULL,   -- Schluessel aus dem Signalkatalog
  punkte      REAL        NOT NULL,
  halbwert_t  REAL        NOT NULL,   -- Tage
  zeitpunkt   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signal_ziel ON signal (ziel_art, ziel_id, zeitpunkt DESC);

-- Abgeleitet, wird neu berechnet, nie von Hand gepflegt.
CREATE TABLE IF NOT EXISTS relevanz (
  ziel_art    TEXT        NOT NULL,
  ziel_id     TEXT        NOT NULL,
  naehe       REAL        NOT NULL,
  gewicht     REAL        NOT NULL,
  rang        REAL        NOT NULL,
  begruendung JSONB       NOT NULL,   -- die drei staerksten Beitraege
  berechnet   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ziel_art, ziel_id)
);

-- Nach dem Entfernen einer Firma: kein Wiederaufwaermen durch Automatik.
CREATE TABLE IF NOT EXISTS relevanz_sperre (
  ziel_art  TEXT        NOT NULL,
  ziel_id   TEXT        NOT NULL,
  bis       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (ziel_art, ziel_id)
);
```

**Aufbewahrung:** Rohsignale werden nach 400 Tagen geloescht (ein Jahr
plus Puffer, damit Jahresvergleiche moeglich bleiben). Der abgeleitete
Wert bleibt. Der Nutzer kann beides jederzeit loeschen, siehe Abschnitt 9.

**Warum nicht im Gateway:** Verhaltensdaten eines namentlich bekannten
Beschaeftigten auf dem Server des Betreibers waeren ein neuer, schwer zu
rechtfertigender Verarbeitungszweck — und sie muessten dann im
Verzeichnis der Verarbeitungstaetigkeiten stehen, im AV-Vertrag, in der
Betriebsvereinbarung. Lokal gibt es diesen ganzen Zweig nicht. Das ist
derselbe Grund, aus dem der ICP-Score lokal liegt.

**Preis dafuer, offen benannt:** Der Score gilt je Geraet. Wer AVA auf
Notebook und Standrechner nutzt, hat zwei Profile, und ein
Geraetewechsel setzt alles zurueck. Ich halte das fuer vertretbar
(Abschnitt 12 hat die Gegenposition als offene Entscheidung); der
Kaltstart in Abschnitt 8 faengt den Fall ab.

---

## 5. Berechnung

### 5.1 Naehe

```
roh(ziel) = Σ  punkte_i · 2^(-alter_i / halbwert_i)
```

Summiert ueber alle Signale des Ziels. Dann auf 1–10 abgebildet — nicht
linear, denn die Rohwerte sind stark rechtsschief (wenige Firmen
sammeln sehr viel):

```
naehe = 1 + 9 · min(1, log(1 + roh) / log(1 + SAETTIGUNG))
SAETTIGUNG = 60      (Rohwert, ab dem 10 erreicht ist)
```

Zur Einordnung: Eine einmal geoeffnete Firma landet bei rund 2. Eine
uebernommene Firma mit drei Ansichten und einer Chat-Erwaehnung bei rund
6. Eine Firma mit Watchlist-Fokus, CRM-Uebernahme und laufendem Workflow
erreicht 10. Ohne neues Signal faellt eine 8 in etwa drei Wochen auf 6
und in zwei Monaten auf 4.

Personen zusaetzlich: `naehe = max(eigene_naehe, firmen_naehe / 2)`.

**Kein Stapeln innerhalb einer Sitzung:** Dasselbe Signal fuer dasselbe
Ziel zaehlt einmal pro Stunde. Wer eine Ansicht zehnmal neu laedt, hat
nicht zehnmal Interesse. Der heutige `InterestStore` loest das ueber
Saettigung bei 1.0; die Ein-Stunde-Regel ist dieselbe Idee, nur
erklaerbarer.

### 5.2 Gewicht

Rein sachlich, vollstaendig aus Vorhandenem:

| Beitrag | Punkte |
| --- | --- |
| ICP-Trefferguete | 0–4 |
| Firmenstatus auffaellig (Insolvenz, Loeschung, Statuswarnung) | +3 |
| In "Meine Firmen" | +2 |
| Pipeline-/CRM-Stand aktiv | +2 |
| Groesse/Umsatz im Zielkorridor des ICP | +1 |

Summe auf 1–10 gedeckelt. Kein Verhalten, kein Verfall.

### 5.3 Rang fuer den Heartbeat

```
rang = 0.6 · naehe + 0.4 · gewicht
```

Aber: **Jede vierte Beobachtungseinheit ist fuer die Entdeckungsspur
reserviert** — die hoechsten Gewichte unter den Zielen mit Naehe ≤ 3, die
am laengsten nicht beobachtet wurden. Ohne diese feste Reserve frisst die
Rueckkopplung aus Abschnitt 0 den Bestand von aussen auf. Die Reserve ist
der eigentliche Kern des ganzen Plans; wenn beim Umsetzen etwas
wegfaellt, dann nicht sie.

Zusaetzlich eine Alterungsregel: Wer laenger als 30 Tage nicht beobachtet
wurde, bekommt +1 auf den Rang, gedeckelt bei +3. Verhungern soll nichts.

### 5.4 Wann gerechnet wird

Nicht bei jedem Signal. Der Wert wird neu bestimmt
- beim Schreiben eines Signals fuer genau dieses eine Ziel (billig, nur
  eine Summe),
- fuer alle Ziele einmal taeglich beim ersten Start nach Mitternacht
  (der Verfall allein aendert Werte auch ohne neue Signale),
- auf Anforderung aus der Oberflaeche.

---

## 6. Wirkung auf den Heartbeat

Heute zieht der Heartbeat Kandidaten vom Gateway und laesst den Judge
urteilen. Kuenftig sortiert er die Kandidaten vorher nach `rang` und
arbeitet in Stufen:

| Rang | Beobachtung | Alarmweg |
| --- | --- | --- |
| 8–10 | jeder Durchlauf (15 min) | Alle Funde ab `info`, Push sofort |
| 6–8 | jeder zweite Durchlauf | ab `warn` sofort, `info` in die Tageszusammenfassung |
| 4–6 | taeglich | nur `warn`/`urgent`, gesammelt |
| 1–4 | woechentlich (plus Entdeckungsspur) | nur `urgent` |

`urgent` umgeht wie bisher die Ruhezeiten — daran aendert der Score
nichts. Und: Statuswarnungen (Insolvenz, Loeschung) gehen **immer**
durch, egal wie kalt die Firma ist. Es waere absurd, die Insolvenz eines
Kunden zu verschweigen, weil ihn niemand angeklickt hat. Solche
Ausnahmen gehoeren fest verdrahtet, nicht in eine Gewichtstabelle.

Der Judge bekommt die Naehe als Zusatzangabe im Prompt ("Der Nutzer hat
sich mit dieser Firma zuletzt intensiv befasst") — nicht als
Entscheidung, sondern als Kontext fuer die Begruendung.

### 6.1 Positionswechsel als Beispiel

Der Fall aus deiner Frage, einmal durchgespielt. Eine Person bekommt
einen neuen Titel:

1. Person hat eigene Naehe ≥ 7 (Profil angesehen, Hinweis kopiert) → Alarm
   `linkedin-signal`, Stufe `warn`, sofort. Das ist der Fall, fuer den es
   die Funktion gibt.
2. Person 4–7 → sammeln, Tageszusammenfassung.
3. Person < 4, aber **Kontaktrang Leitung** und Firma im Gewicht ≥ 7 →
   Tageszusammenfassung. Ein Geschaeftsfuehrerwechsel bei einer gut
   passenden Firma ist sachlich relevant, auch ohne Vorgeschichte.
4. Sonst → nur im Datensatz, kein Alarm. Bei 2000 Firmen ist das die
   grosse Mehrheit, und genau das ist der Punkt.

Das loest das "jedes Mal wenn irgendjemand" ohne neue Alarmart, ohne
neuen Judge und ohne zusaetzlichen LLM-Aufruf.

---

## 7. Oberflaeche

- **Firmenansicht:** kleine Waermeanzeige neben dem Namen, 1–10, mit
  Kurztext beim Darueberfahren ("Du hast diese Firma 4-mal geoeffnet,
  zuletzt vor 2 Tagen, und einen Kontakt ins CRM uebernommen"). Die drei
  staerksten Beitraege stehen in `begruendung` — ohne sie ist die Zahl
  eine Zumutung.
- **Kontakt-Tab:** dieselbe Anzeige je Person, klein, neben dem Rang.
- **Einstellungen → Relevanz:** Schalter, Rohsignale ansehen,
  "Alles loeschen", "Fuer diese Firma vergessen".
- **Keine Bestenliste.** Eine Liste "deine heissesten Firmen" klingt
  reizvoll und waere in einer Organisation der schnellste Weg zu
  Leistungsvergleichen zwischen Mitarbeitern. Nicht bauen.

---

## 8. Kaltstart

Am ersten Tag ist jede Naehe 1. Damit AVA nicht wirkungslos wirkt:

- Solange weniger als 20 Signale vorliegen, zaehlt allein das **Gewicht**.
  AVA verhaelt sich dann wie heute — sachlich sortiert.
- Beim ersten Start nach dem Einschalten wird die Naehe einmalig aus
  **vorhandenen Spuren** geschaetzt, ohne neue Erfassung: Firmen in
  "Meine Firmen" starten bei 4, Watchlist-Fokus bei 7, Firmen mit
  laufendem Workflow bei 6, CRM-verknuepfte bei 6. Das sind Handlungen,
  die der Nutzer bereits vollzogen hat; sie neu zu erfassen waere
  Unsinn.
- Der Uebergang wird einmal im Chat erklaert, nicht stillschweigend
  vollzogen.

---

## 9. Datenschutz und Abschaltbarkeit

Nicht verhandelbar, sonst faellt die Funktion in Unternehmen aus:

1. **Standardmaessig aus.** Erst-Einwilligung im Klartext mit Aufzaehlung
   dessen, was erfasst wird. Kein vorangekreuztes Kaestchen.
2. **Jederzeit abschaltbar**, mit sofortiger Wirkung. Beim Abschalten
   fragt AVA, ob die gesammelten Signale geloescht werden sollen.
3. **Lokal, nie ausgeliefert.** Kein Signal verlaesst das Geraet — nicht
   ans Gateway, nicht an die Organisation, nicht in Telemetrie.
4. **Einsehbar.** Vollstaendige Liste der Rohsignale in den
   Einstellungen, exportierbar. Was der Nutzer nicht nachlesen kann,
   sollte er nicht hinnehmen muessen.
5. **Punktuelles Vergessen** je Firma und je Person.
6. **Keine Organisationsauswertung.** Kein Endpunkt, kein Export, keine
   Aggregation ueber Nutzer hinweg. Sollte das je gewuenscht werden, ist
   es ein eigener Plan mit eigener Rechtsgrundlage — nicht ein
   Nebenprodukt von diesem.
7. **Betriebsvereinbarungs-Hinweis** in der Dokumentation: Beim Einsatz
   in Unternehmen mit Betriebsrat ist diese Funktion mitbestimmungs-
   pflichtig. Das gehoert in die Freigabedokumente
   (`PLAN_ENTERPRISE_FREIGABE.md`), nicht nur in eine Fussnote.

Die Erfassung von Kontaktpersonen beruehrt zusaetzlich deren Rechte.
Neue personenbezogene Daten entstehen dabei aber nicht: Erfasst wird,
was **der Nutzer** getan hat, nicht was die Person getan hat. Das ist die
saubere Trennlinie, und sie sollte in der Dokumentation genau so stehen.

---

## 10. Chat-Tool (Pflicht)

Nach der bestehenden Regel braucht jede neue Einstellung auch ein
Agent-Tool:

- `relevanz_status` — Naehe und Gewicht einer Firma/Person mit Begruendung.
- `relevanz_liste` — die naechsten Beobachtungsziele mit Rang (das ist
  keine Bestenliste ueber Nutzer, sondern die Arbeitsvorschau des
  Heartbeats).
- `relevanz_vergessen` — Signale eines Ziels loeschen (`confirmAction`).
- `relevanz_einstellen` — ein/aus, Schwellen (`confirmAction`).

Dazu ein Eintrag in der Faehigkeitsgruppen-Pflege der Chat-Vorschlaege.

---

## 11. Umsetzungsstufen

| Stufe | Inhalt | Ergebnis |
| --- | --- | --- |
| **R0** | Speicher `main/relevanz/` mit Schema, Signal schreiben, Naehe rechnen, Einwilligung, Schalter. Noch ohne Wirkung. | Erfassung laeuft, nichts aendert sich sichtbar |
| **R1** | Vorhandene Signale anschliessen: Detailansicht, Chat-Link, Uebernehmen, Import, Workflow, Watchlist. `InterestStore` liest neu, schreibt nicht mehr selbst. | Erste echte Werte |
| **R2** | Gewicht aus ICP/Status/Pipeline; Rang; Anzeige in der Firmenansicht mit Begruendung. | Nutzer sieht und versteht den Wert |
| **R3** | Heartbeat-Priorisierung inklusive Entdeckungsspur und Alterung. | Beobachtung folgt dem Rang |
| **R4** | Personensignale: Profilklick, DSGVO-Hinweis, CRM, E-Mail, Kontaktsuche. Vererbung von der Firma. | Personen werden unterscheidbar |
| **R5** | Alarmschwellen je Rang, Tageszusammenfassung fuer Gesammeltes, feste Ausnahmen (Statuswarnungen). | Der Positionswechsel-Fall ist geloest |
| **R6** | Chat-Tools, Einsicht und Export in den Einstellungen, punktuelles Vergessen. | Vollstaendig bedienbar |

R0–R2 sind die Grundlage und sollten zusammen kommen. R3 und R5 tragen
den Nutzen. R4 ist der Teil, nach dem gefragt wurde, braucht aber R0–R2
darunter.

---

## 12. Offene Entscheidungen

1. **Gewichte und Halbwertszeiten.** Die Zahlen in Abschnitt 3 sind
   geschaetzt. Vorschlag: fest verdrahtet starten, nach vier Wochen
   anhand echter Verteilungen nachziehen. Keine Einstellmoeglichkeit fuer
   Nutzer — sonst justiert niemand, und jede Fehlersuche braucht zuerst
   eine Konfigurationsabfrage.
2. **Geraeteuebergreifend?** Heute: nein, lokal je Geraet. Eine
   verschluesselte Ablage im Gateway waere technisch machbar (Schluessel
   beim Nutzer), widerspricht aber Abschnitt 9.3 dem Geist nach. Meine
   Empfehlung: erst bauen, wenn jemand es vermisst.
3. **Organisationsaggregat.** "Diese Firma interessiert 4 Kollegen" waere
   sehr nuetzlich fuer den Vertrieb und sehr heikel fuer den Betriebsrat.
   Wenn ueberhaupt, dann: nur Anzahl, nie Namen, Mindestzahl 3, und nur
   wenn die Organisation es ausdruecklich einschaltet. Eigener Plan.
4. **Saettigung bei 60.** Bestimmt, wie schnell eine 10 erreicht wird.
   Nach den ersten Wochen an der tatsaechlichen Verteilung pruefen.
5. **Alarm weggewischt = negativ.** Ich halte es fuer richtig, es ist
   aber eine Wertung: Wegwischen kann auch "gesehen, erledigt" heissen.
   Vorschlag: erst ab dem dritten Wegwischen derselben Alarmart bei
   derselben Firma zaehlen.
6. **Entdeckungsspur ein Viertel.** Der Anteil bestimmt, wie stark AVA
   ueber den Tellerrand sieht. Zu klein und sie ist wirkungslos; zu gross
   und der Heartbeat vernachlaessigt das Wichtige.
7. **Freitext-Erkennung von Firmennamen im Chat.** Bewusst draussen
   (3.4). Falls die Abdeckung ohne sie zu duenn ist, waere der saubere
   Weg ein Abgleich nur gegen "Meine Firmen", nicht gegen den Gesamtbestand.

---

## 13. Was wir bewusst nicht bauen

- **Keine Champions.** Das Nachverfolgen von Firmenwechseln bekannter
  Kontakte ist eine eigene Funktion mit eigenem Nutzen; sie gehoert nicht
  in einen Aufmerksamkeitswert. (Eigener Plan, falls gewuenscht.)
- **Keine Vorhersage.** Der Score sagt, was war, nicht was kommt. "Diese
  Firma wird bald kaufen" braucht Abschlussdaten, die AVA nicht hat, und
  waere ohne sie geraten.
- **Kein Score ueber Nutzer hinweg.** Siehe Abschnitt 9.6.
- **Keine Erfassung ohne Einwilligung**, auch nicht "anonym zur
  Verbesserung".
