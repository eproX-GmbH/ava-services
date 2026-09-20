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

**Zweitens: Der Score stuft hoch, er unterdrueckt nicht.** Das ist die
wichtigste Festlegung im ganzen Plan, und mein erster Entwurf hatte sie
falsch herum. Eine kalte Firma meldet weiterhin alles, was sie heute
meldet — Geschaeftsfuehrerwechsel, Insolvenz, starke Zahlen im
Jahresabschluss, ICP-Treffer gehen immer sofort durch. Was der Wert tut,
ist das Gegenteil von Filtern: Bei einer Firma, an der gerade gearbeitet
wird, wiegt dieselbe Beobachtung schwerer — aus einem Hinweis wird eine
Warnung, aus einer Warnung eine dringende Meldung.

Der Grund ist eine Asymmetrie der Fehler. Eine Meldung zu viel kostet
einen Klick. Eine unterdrueckte Meldung ueber die Insolvenz eines Kunden
kostet den Kunden — und der Nutzer merkt nie, dass sie fehlte, kann den
Fehler also auch nicht melden. Ein System, dessen Fehler unsichtbar
sind, korrigiert sich nie.

Gesammelt statt sofort zugestellt wird deshalb genau eine Sache: das
Rauschen aus Feed und Website-Ueberwachung bei Firmen, an denen gerade
niemand arbeitet. Und auch das wird gesammelt, nicht verworfen.

**Drittens: Die Signale liegen zentral — und damit haengt alles an der
Trennung je Nutzer.** Die Daten gehen in die zentrale Datenbank, nicht
auf das Geraet. Das macht den Wert geraeteuebergreifend und
neuinstallationsfest, es macht ihn aber auch zu einem eigenen
Verarbeitungszweck: Verhaltensdaten namentlich bekannter Beschaeftigter
auf dem Server des Betreibers. Die naheliegende Zusage "verlaesst dein
Geraet nicht" steht damit nicht zur Verfuegung, und an ihre Stelle muss
etwas Belastbares treten:

- Trennung nach `tenantId` **und** `actorId`, aus dem JWT abgeleitet.
  Kein Endpunkt, ueber den ein anderer Nutzer adressierbar waere, auch
  nicht von Administratoren der Organisation.
- Keine Auswertung ueber Nutzer hinweg. Keine Bestenliste, kein Export,
  kein Aggregat.
- Einsicht und Loeschung fuer den Nutzer, jederzeit und vollstaendig.
- Eintrag in Verarbeitungsverzeichnis, AV-Vertrag und
  Enterprise-Freigabe.

Damit bleibt der Standardzustand **an** (Opt-out) vertretbar: Der Nutzer
sieht seine Daten, niemand sonst sieht sie, und die Organisation kann die
Funktion fuer ihre Mitglieder abschalten — das ist der Weg fuer eine
Betriebsvereinbarung. Was ich nicht verschweige: Der Aufwand dieser
Entscheidung faellt nicht in der Technik an, sondern in der
Dokumentation, und er faellt vor der ersten Enterprise-Freigabe an, nicht
danach.

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

Fuer jedes Paar (Nutzer, Firma) und (Nutzer, Person) fuehrt AVA:

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
Nachjustieren, kein Naturgesetz — Abschnitt 13 nennt sie als offene
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
| Alarm weggewischt, ab dem 3. Mal derselben Art | **-3** | 30 Tage | Alarmliste |
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

Entscheidend ist nicht der Name, sondern die **companyId** — nur ueber
sie laesst sich der Wert ueberhaupt verknuepfen. Ein erkannter Name ohne
ID ist wertlos. Und die ID liegt ohnehin vor: Nennt der Nutzer eine
Firma, sucht der Agent sie per Werkzeug, und ab da ist sie eindeutig.

Erfasst wird deshalb an drei Stellen, alle ohne zusaetzlichen
LLM-Aufruf:

1. **IDs in den Argumenten eines Werkzeugaufrufs.** Wer ein Tool mit
   `companyId` oder `personId` aufruft, zeigt genau auf dieses Ziel.
   Zaehlt immer.
2. **IDs im Ergebnis einer Firmensuche — aber nur bei wenigen Treffern.**
   Loest `company_search("Zimmer Rheinau")` zu einem oder zwei Treffern
   auf, ist gemeint, was der Nutzer gesucht hat. Ab **mehr als drei**
   Treffern zaehlt nichts: Eine Liste ist eine Liste, kein Interesse an
   jedem Eintrag (dieselbe Regel wie fuer Listenansichten in 3.3).
3. **Firmenlinks** `[Name](company:ID)` im Chatverlauf, wenn sie geklickt
   werden — deckt ab, was AVA selbst genannt hat.

Praktisch heisst das: Das Werkzeugprotokoll des laufenden Zuges wird
nach `companyId`/`personId` durchsucht, am Ende des Zuges gebuendelt und
in die Warteschlange gelegt. Kein Durchsuchen von Fliesstext, kein
zweites Modell, keine Namensaufloesung.

Freitext-Erkennung ("die Zimmer aus Rheinau" ohne vorangegangenen
Werkzeugaufruf) bleibt bewusst aussen vor: Ein unscharfer Abgleich gegen
2000 Firmennamen liefert genau die falschen Treffer, die das Ranking
spaeter unerklaerlich machen — und er wird kaum gebraucht, weil der
Agent bei einer genannten Firma ohnehin sucht.

**Was der Agent selbst anstoesst, zaehlt nicht.** Ruft der Heartbeat
oder ein Workflow ein Tool mit einer `companyId` auf, entsteht kein
Signal (3.3, letzter Punkt). Erfasst wird nur, was an einem Zug haengt,
den ein Mensch ausgeloest hat.

---

## 4. Datenmodell (zentral, Gateway)

Die Signale liegen in der zentralen Datenbank, nicht auf dem Geraet.
Das ist eine bewusste Setzung; was sie bringt und was sie kostet, steht
am Ende dieses Abschnitts und in Abschnitt 9.

### 4.1 Tabellen (Prisma, `services/db-gateway/prisma/schema.prisma`)

Streng nach `tenantId` **und** `actorId` getrennt, wie AuditLog und
UsageEntry. Der Nutzer ist die Einheit, nicht die Organisation: Zwei
Mitglieder derselben Organisation haben getrennte Werte fuer dieselbe
Firma, und keine Abfrage mischt sie.

```prisma
/// Rohsignal: eine Handlung des Nutzers an einer Firma oder Person.
model RelevanzSignal {
  id        BigInt   @id @default(autoincrement())
  tenantId  String
  actorId   String
  zielArt   String   // 'firma' | 'person'
  zielId    String
  firmaId   String?  // bei Personen: Firma, ueber die sie kam
  art       String   // Schluessel aus dem Signalkatalog
  punkte    Float
  halbwertT Float    // Tage
  zeitpunkt DateTime @default(now())

  @@index([tenantId, actorId, zielArt, zielId, zeitpunkt])
  @@index([zeitpunkt])                       // fuer die Tilgung
}

/// Abgeleitet. Wird neu berechnet, nie von Hand gepflegt.
model RelevanzWert {
  tenantId    String
  actorId     String
  zielArt     String
  zielId      String
  naehe       Float
  gewicht     Float
  rang        Float
  begruendung Json     // die drei staerksten Beitraege
  berechnet   DateTime @default(now())

  @@id([tenantId, actorId, zielArt, zielId])
  @@index([tenantId, actorId, rang])         // Arbeitsvorschau des Heartbeats
}

/// Nach dem Entfernen einer Firma: kein Wiederaufwaermen durch Automatik.
model RelevanzSperre {
  tenantId String
  actorId  String
  zielArt  String
  zielId   String
  bis      DateTime

  @@id([tenantId, actorId, zielArt, zielId])
}
```

Migration nach bestehendem Muster unter
`prisma/migrations/2026…_relevanz/`.

### 4.2 Endpunkte

| Route | Zweck |
| --- | --- |
| `POST /v1/relevanz/signale` | Buendel von Signalen schreiben (siehe 4.3) |
| `GET /v1/relevanz?zielArt=&ids=` | Werte fuer bestimmte Ziele lesen |
| `GET /v1/relevanz/vorschau?limit=` | nach Rang sortierte Arbeitsvorschau fuer den Heartbeat |
| `GET /v1/relevanz/signale?zielId=` | Rohsignale eines Ziels, fuer die Einsicht in den Einstellungen |
| `DELETE /v1/relevanz/signale` | alles oder ein Ziel vergessen |

Alle Routen leiten `tenantId` und `actorId` **ausschliesslich aus dem
JWT** ab. Kein Parameter, mit dem sich ein anderer Nutzer adressieren
liesse — auch nicht fuer Administratoren der Organisation. Wer den
Endpunkt kennt, kommt trotzdem nur an die eigenen Daten.

### 4.3 Ausgang auf dem Geraet (wichtig)

Ein Netzaufruf je Klick waere dreifach falsch: er haengt die Oberflaeche
an die Netzverbindung, er erzeugt Last fuer Daten, die niemand in der
Sekunde braucht, und er macht AVA ohne Netz stumpf. Also:

- Signale gehen zuerst in eine kleine lokale Warteschlange
  (`userData/relevanz/ausgang.json`, gedeckelt auf 5000 Eintraege).
- Uebertragen wird gebuendelt: alle 60 Sekunden, spaetestens bei 50
  Eintraegen, und beim ordentlichen Beenden.
- Scheitert die Uebertragung, bleibt der Eintrag liegen und wird beim
  naechsten Versuch mitgenommen. Jedes Signal traegt eine vom Geraet
  vergebene Kennung, damit ein wiederholter Versuch nichts doppelt
  schreibt.
- Umgekehrt haelt das Geraet die gelesenen Werte im Speicher vor
  (Neuladen alle 15 Minuten, angestossen vom Heartbeat). Ohne Netz
  arbeitet AVA mit dem zuletzt bekannten Stand weiter, statt so zu tun,
  als waere alles kalt.

Die Warteschlange ist ein Puffer, kein zweiter Speicher: Uebertragenes
wird geloescht.

### 4.4 Wo gerechnet wird

Im Gateway. Das ist kein Bruch der Rechenlokalitaet — die gilt fuer
Sprachmodelle und das Einsammeln von Daten, nicht fuer eine gewichtete
Summe ueber ein paar tausend Zeilen. Der Wert dort zu bilden, wo die
Signale liegen, erspart das Herunterladen aller Rohsignale auf jedes
Geraet und haelt die Werte ueber Geraete hinweg gleich.

Das **Gewicht** (Abschnitt 5.2) entsteht weiterhin lokal aus ICP und
Firmenstatus und wird beim Buendel-Schreiben mitgeschickt. Ein ICP-Profil
gehoert nicht in die zentrale Datenbank, nur seine Wirkung als Zahl.

### 4.5 Aufbewahrung und Tilgung

- Rohsignale aelter als **400 Tage** werden geloescht. Ein taeglicher
  Lauf im bestehenden Cron des Gateways, nach dem Muster von
  `billing-cron.ts`.
- Der abgeleitete Wert bleibt, bis der Nutzer ihn loescht.
- Verlaesst ein Mitglied die Organisation oder wird ein Konto geloescht,
  fallen seine Zeilen mit. Das gehoert in denselben Ablauf, der heute
  schon Mitgliedschaften aufloest — nicht in einen Handgriff, an den
  sich jemand erinnern muss.

### 4.6 Was das bringt und was es kostet

**Dafuer:** Der Wert gilt geraeteuebergreifend — Notebook und
Standrechner sehen dasselbe, eine Neuinstallation verliert nichts, ein
Geraetewechsel auch nicht. Damit ist die offene Entscheidung 2 aus der
ersten Fassung erledigt. Ausserdem waere eine Organisationsauswertung
damit technisch moeglich; sie bleibt trotzdem gesperrt (9.3).

**Dagegen, offen benannt:** Verhaltensdaten namentlich bekannter
Beschaeftigter auf dem Server des Betreibers sind ein eigener
Verarbeitungszweck. Er muss ins Verzeichnis der
Verarbeitungstaetigkeiten, in den AV-Vertrag und in die Unterlagen fuer
die Enterprise-Freigabe. Die Zusage "verlaesst dein Geraet nicht" steht
nicht mehr zur Verfuegung; an ihre Stelle treten die Zusagen aus
Abschnitt 9.3. Das ist eine Entscheidung mit Folgekosten in der
Dokumentation, nicht in der Technik — die Technik wird dadurch eher
einfacher.

---

## 5. Berechnung

### 5.1 Naehe

```
roh(ziel) = Σ punkte_i · 2^(-alter_i / halbwert_i)   +   wiederkehr(ziel)
```

**Wiederkehr ist der wichtigste Teil.** Ein einzelner Aufruf heisst
wenig — vielleicht hat jemand danebengeklickt. Wer aber an einem zweiten
und dritten Tag zurueckkommt, hat eine Entscheidung getroffen. Genau das
war in der ersten Fassung zu schwach:

```
wiederkehr(ziel) = 4 · min(5, anzahl_verschiedener_tage_mit_signal - 1)
```

Also nichts am ersten Tag, +4 am zweiten, +8 am dritten, gedeckelt bei
+20. Verschiedene **Tage**, nicht verschiedene Aufrufe: Zehnmal
neuladen ist kein Interesse, am naechsten Morgen wiederkommen schon.
Der Deckel verhindert, dass eine Firma, die jemand taeglich streift,
alles andere verdraengt.

Die Abbildung auf 1–10 ist logarithmisch, denn die Rohwerte sind stark
rechtsschief:

```
naehe = 1 + 9 · min(1, ln(1 + roh) / ln(1 + SAETTIGUNG))
SAETTIGUNG = 30      (Rohwert, ab dem 10 erreicht ist)
```

Was dabei herauskommt — diesmal nachgerechnet, nicht geschaetzt:

| Verhalten | roh | Naehe |
| --- | --- | --- |
| einmal geoeffnet | 3 | 4,6 |
| dreimal am selben Tag geoeffnet | 9 | 7,0 |
| an zwei Tagen geoeffnet | 10 | 7,2 |
| **an drei Tagen geoeffnet** | **17** | **8,6** |
| an drei Tagen, davon einmal im Chat erwaehnt | 22 | 9,2 |
| Watchlist-Fokus | 18 | 8,7 |
| uebernommen + Kontakt ins CRM | 28 | 9,8 |

Drei Aufrufe an drei Tagen landen also bei 8,6 — brennend heiss, wie du
es beschrieben hast, und ohne dass der Nutzer irgendetwas erklaeren
muss. Ein einzelner Aufruf bei 4,6 ist lauwarm: genug, um beobachtet zu
werden, zu wenig fuer sofortige Alarme.

Ohne neues Signal faellt eine 8,6 in etwa drei Wochen auf 7 und in zwei
Monaten auf 5,5. Der Wiederkehr-Anteil verfaellt mit, gerechnet ab dem
letzten Signal — sonst bliebe eine vor einem Jahr intensiv bearbeitete
Firma fuer immer warm.

Personen zusaetzlich: `naehe = max(eigene_naehe, firmen_naehe / 2)`.

**Kein Stapeln innerhalb einer Stunde:** Dasselbe Signal fuer dasselbe
Ziel zaehlt einmal je Stunde. Wer eine Ansicht zehnmal neu laedt, hat
nicht zehnmal Interesse. Zwei Aufrufe am Vormittag und am Nachmittag
zaehlen dagegen beide — das ist echtes Wiederaufgreifen.

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

Im Gateway, nicht bei jedem Signal:

- beim Eintreffen eines Signalbuendels fuer genau die betroffenen Ziele
  (billig, nur eine Summe je Ziel),
- fuer alle Ziele eines Nutzers einmal taeglich im Cron-Lauf (der Verfall
  allein aendert Werte auch ohne neue Signale),
- auf Anforderung aus der Oberflaeche.

Das Geraet rechnet nicht mit, es liest. Zwischen zwei Abrufen arbeitet
es mit dem zuletzt bekannten Stand (4.3) — bei einer Groesse, die sich
ueber Tage bewegt, faellt ein Viertelstuendchen Verzug nicht ins
Gewicht.

---

## 6. Wirkung auf den Heartbeat

Heute zieht der Heartbeat Kandidaten vom Gateway und laesst den Judge
urteilen. Kuenftig sortiert er sie vorher nach `rang` — und behandelt
die Funde danach unterschiedlich.

**Die Richtung ist wichtig, und die erste Fassung dieses Plans hatte sie
falsch herum: Der Wert unterdrueckt nichts. Er stuft hoch.**

Eine kalte Firma meldet weiterhin alles, was sie heute meldet. Ein
Geschaeftsfuehrerwechsel, eine Insolvenz, ein starkes Signal im
Jahresabschluss, ein ICP- oder Best-Match-Treffer gehen **immer** sofort
durch, egal wie lange niemand hingesehen hat. Alles andere waere ein
Datenverlust, den der Nutzer nicht bemerkt und deshalb auch nicht
korrigieren kann — der schlimmste Fehler, den ein System wie dieses
machen kann.

Was der Wert stattdessen tut: Bei einer Firma, an der gerade gearbeitet
wird, wird **genauer hingesehen**. Dieselbe Beobachtung wiegt dort
schwerer.

| Rang | Beobachtung | Einstufung |
| --- | --- | --- |
| ab 9 (brennend) | jeder Durchlauf (15 min) | **alles wird `urgent`** — auch eine Nebensaechlichkeit |
| ab 7 (heiss) | jeder Durchlauf | eine Stufe hoch: `info` → `warn`, `warn` → `urgent` |
| 4–7 | jeder zweite Durchlauf | unveraendert |
| unter 4 | taeglich (plus Entdeckungsspur) | unveraendert |

Die Beobachtungshaeufigkeit bleibt also gestaffelt — heisse Firmen werden
oefter angesehen —, die Zustellung wird aber nie schwaecher als ohne den
Wert.

### 6.1 Das Einzige, was gesammelt wird

Genau eine Sache geht nicht sofort raus: **Rauschen aus Feed und
Website-Ueberwachung bei Firmen, an denen gerade niemand arbeitet** — also
`linkedin-signal` und `link-change` auf Stufe `info` bei Rang unter 6.
Das war die urspruengliche Frage: Bei 2000 Firmen waere ein Ping bei jedem
neuen Positionstitel irgendeines Mitarbeiters uebertrieben.

Auch das wird **gesammelt, nicht verworfen**, und erscheint am selben Tag
in einer Zusammenfassung. Die Liste der sammelbaren Arten ist eine
**Positivliste**: Eine kuenftig neue Meldungsart ist damit im Zweifel
sofort zustellbar und nicht versehentlich still.

Ein unbekannter Rang zaehlt dabei NICHT als kalt. Eine Firma, ueber die
AVA nichts weiss, ist nicht dasselbe wie eine, die niemanden
interessiert.

### 6.2 Folge, die man kennen muss

`urgent` umgeht die Ruhezeiten (19–07 und Wochenende). Eine brennend
heisse Firma kann deshalb auch nachts melden. Das ist gewollt — wer eine
Firma so eng verfolgt, will nicht am naechsten Morgen erfahren, dass
etwas passiert ist —, aber es ist eine echte Verhaltensaenderung. Deshalb
steht die Hochstufung auch in der Begruendung der Meldung: Sonst kaeme
nachts eine dringende Meldung, deren Text nach einer Nebensaechlichkeit
klingt, und niemand verstuende warum.

### 6.3 Der Positionswechsel, einmal durchgespielt

Eine Person bekommt einen neuen Titel:

1. Firma brennend heiss (Rang ≥ 9, gerade in Bearbeitung) → `urgent`,
   sofort, auch nachts. Das ist der Fall, fuer den es die Funktion gibt.
2. Firma heiss (Rang ≥ 7) → aus `info` wird `warn`, sofort.
3. Firma dazwischen (4–7) → wie bisher, sofort als `info`.
4. Firma ruht (unter 6) und es ist nur ein Feed-Signal → Tages-
   zusammenfassung. Bei 2000 Firmen ist das die grosse Mehrheit.
5. Es ist aber ein **Geschaeftsfuehrerwechsel aus dem Handelsregister**
   (`profile-change`) → sofort, auch bei einer Firma, die seit Monaten
   ruht. Das ist kein Rauschen.

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
- **Einstellungen → Relevanz:** Schalter (an, solange die Organisation
  nichts anderes setzt), Rohsignale ansehen, "Alles loeschen", "Fuer
  diese Firma vergessen". Hat die Organisation bindend gesetzt, steht
  dort statt des Schalters ein Satz, der das sagt — und wenn sie die
  Funktion abgeschaltet hat, ist der ganze Abschnitt weg.
- **Keine Bestenliste ueber Mitglieder.** Eine eigene Liste "deine
  heissesten Firmen" ist in Ordnung und faellt mit der Sortierung nach
  Rang ohnehin ab. Was es nicht gibt, ist eine Ansicht, die **Mitglieder**
  vergleichbar macht — das Aggregat aus Abschnitt 10 zaehlt Firmen, nicht
  Menschen.

---

## 8. Kaltstart

Am ersten Tag ist jede Naehe 1. Damit AVA nicht wirkungslos wirkt:

- Solange weniger als 20 Signale vorliegen, zaehlt allein das **Gewicht**.
  AVA verhaelt sich dann wie heute — sachlich sortiert.
- Beim allerersten Start wird die Naehe einmalig aus
  **vorhandenen Spuren** geschaetzt, ohne neue Erfassung: Firmen in
  "Meine Firmen" starten bei 4, Watchlist-Fokus bei 7, Firmen mit
  laufendem Workflow bei 6, CRM-verknuepfte bei 6. Das sind Handlungen,
  die der Nutzer bereits vollzogen hat; sie neu zu erfassen waere
  Unsinn.
- Der Uebergang wird einmal im Chat erklaert, nicht stillschweigend
  vollzogen.

---

## 9. Standardzustand, Organisation und Abschaltbarkeit

### 9.1 An, sofern niemand widerspricht

Die Funktion ist **standardmaessig eingeschaltet** — beim Einzelnutzer wie
in der Organisation. Sie ist der Kern dessen, was AVA nuetzlich macht;
eine Fassung, die erst nach einem Haken zu arbeiten beginnt, waere fuer
die meisten Nutzer schlicht eine schlechtere Fassung. Opt-out, nicht
Opt-in.

Beim ersten Start wird einmal im Klartext erklaert, was erfasst wird,
wo es gespeichert wird (in der zentralen Datenbank von AVA, getrennt je
Nutzer) und wer es sehen kann (nur der Nutzer selbst), mit dem Schalter
gleich daneben. Kein Dialog, der den Weg versperrt, aber auch kein
stilles Anschalten: Wer es nicht will, findet es in derselben Sekunde, in
der er davon erfaehrt. Weil die Daten den Rechner verlassen, ist dieser
Hinweis hier keine Hoeflichkeit, sondern Pflicht.

### 9.2 Organisation bestimmt, kann aber Selbstbestimmung erlauben

Es gilt dasselbe Muster wie bei den uebrigen Organisationsfunktionen:
**Die Organisation setzt fuer ihre Mitglieder, kann die Entscheidung aber
an sie abgeben.**

- Neuer Schluessel in `ORG_FEATURES`: `relevanz` mit dem Hinweistext
  "Naehe-Wert je Firma und Person aus dem eigenen Verhalten (bleibt auf
  dem Geraet des Mitglieds)". Fehlender Schluessel bedeutet wie ueberall
  **erlaubt** — die Funktion laeuft also ohne jedes Zutun.
- Neues Feld in `OrgPolicy`, nach dem Vorbild von `apifyEigenerErlaubt`:

  ```ts
  /** Duerfen Mitglieder den Relevanz-Wert selbst ein- und ausschalten?
   *  true (Standard) = die Einstellung der Organisation ist Vorgabe, das
   *  Mitglied darf abweichen. false = die Setzung der Organisation gilt
   *  fuer alle, der Schalter des Mitglieds ist nicht vorhanden. */
  relevanzSelbstbestimmt?: boolean;
  ```

Daraus ergeben sich genau drei Zustaende:

| Organisation | Mitglied | Ergebnis |
| --- | --- | --- |
| `relevanz` erlaubt (Standard), `relevanzSelbstbestimmt` = true | frei | An, das Mitglied kann abschalten |
| `relevanz` erlaubt, `relevanzSelbstbestimmt` = false | kein Schalter | An fuer alle, verbindlich |
| `relevanz` abgeschaltet | kein Schalter | Aus fuer alle; der Weg fuer die Betriebsvereinbarung |

Schaltet die Organisation `relevanz` ab, verschwindet die Funktion nach
der bestehenden Regel **vollstaendig** aus der Oberflaeche: keine
ausgegrauten Karten, keine Waermeanzeige ohne Wert, keine Menuepunkte,
keine Erwaehnung im Chat-Prompt, keine Chat-Tools. Der Heartbeat
arbeitet dann wie heute allein nach dem Gewicht. Vorhandene Signale des
Mitglieds werden beim Abschalten auf dem Geraet geloescht — eine
stillgelegte Sammlung waere das Schlechteste aus beiden Welten.

Fuer den Einzelnutzer (Tenant-Art `personal`) gibt es weder Richtlinie
noch Frage: an, mit Schalter in den Einstellungen.

### 9.3 Was unabhaengig vom Schalter gilt

Da die Daten zentral liegen, tragen diese fuenf Punkte das, was frueher
die Ortswahl getragen haette. Sie sind deshalb keine guten Vorsaetze,
sondern Bedingungen:

1. **Nur der Nutzer selbst.** `tenantId` und `actorId` kommen aus dem
   JWT; es gibt keinen Parameter, ueber den ein anderer Nutzer
   adressierbar waere. Auch der Administrator der Organisation sieht die
   Signale seiner Mitglieder **nicht** — weder in der Oberflaeche noch
   ueber einen Endpunkt. Genau das macht den Standardzustand "an"
   vertretbar; faellt es weg, faellt auch er.
2. **Keine personenbezogene Auswertung ueber Nutzer hinweg.** Kein
   Export, keine Bestenliste, keine Kennzahl im Abrechnungsbereich, und
   nichts, woraus sich ablesen laesst, was eine **bestimmte** Person tut.
   Erlaubt ist allein das Aggregat aus Abschnitt 10: eine blosse Anzahl,
   ohne Namen, mit Mindestzahlen gegen Rueckschluss. Die Grenze verlaeuft
   nicht bei "Zahl ja/nein", sondern dort, wo aus der Zahl eine Person
   wird.
3. **Jederzeit abschaltbar**, sofern die Organisation es nicht bindend
   gesetzt hat, mit sofortiger Wirkung. Beim Abschalten fragt AVA, ob die
   gesammelten Signale geloescht werden sollen; "ja" loescht sie in der
   zentralen Datenbank, nicht nur die Anzeige.
4. **Einsehbar.** Vollstaendige Liste der Rohsignale in den
   Einstellungen, exportierbar. Was der Nutzer nicht nachlesen kann,
   sollte er nicht hinnehmen muessen — das gilt besonders dort, wo die
   Organisation die Funktion vorgibt und die Daten nicht bei ihm liegen.
5. **Punktuelles Vergessen** je Firma und je Person, sowie Tilgung nach
   400 Tagen und beim Ausscheiden aus der Organisation (4.5).

### 9.4 Mitbestimmung: ein Enterprise-Thema, kein Standard-Thema

Beim Einsatz in einem Unternehmen mit Betriebsrat ist eine Erfassung
dieser Art mitbestimmungspflichtig. Der richtige Ort dafuer ist die
Enterprise-Freigabe, nicht der Standardzustand fuer alle anderen: Die
Organisation kann die Funktion fuer ihre Mitglieder abschalten
(9.2, dritte Zeile), und genau das ist der Hebel, den ein Betriebsrat
braucht. Aufzunehmen in `docs/PLAN_ENTERPRISE_FREIGABE.md`:

- der Schalter `relevanz` als Punkt der Freigabecheckliste,
- eine Musterbeschreibung dessen, was erfasst wird und was nicht
  (Abschnitt 3.3 ist dafuer schon geschrieben),
- **ein Eintrag im Verzeichnis der Verarbeitungstaetigkeiten und im
  AV-Vertrag.** Das ist die unmittelbare Folge der zentralen Ablage und
  keine Formalie: Ohne ihn ist die Funktion in einem Unternehmen nicht
  sauber einsetzbar. Zweck, Kategorien, Speicherdauer (400 Tage),
  Empfaenger (keine), Ort der Verarbeitung.
- die Feststellung, dass weder die Organisation noch ihre
  Administratoren die Signale einsehen koennen und keine Auswertung
  ueber Mitarbeiter hinweg existiert. Das ist in der Praxis das
  Argument, das eine Betriebsvereinbarung ueberhaupt erst einfach macht —
  und es traegt nur, solange 9.3.1 und 9.3.2 unangetastet bleiben.

Die Erfassung von Kontaktpersonen beruehrt zusaetzlich deren Rechte.
Neue personenbezogene Daten entstehen dabei aber nicht: Erfasst wird,
was **der Nutzer** getan hat, nicht was die Person getan hat. Das ist die
saubere Trennlinie, und sie sollte in der Dokumentation genau so stehen.

---

## 10. Was gerade Thema ist (Organisationsaggregat)

Aus den einzelnen Werten laesst sich etwas machen, das keiner allein
sehen kann: **welche Firmen die Organisation gerade beschaeftigen.** Das
ist der Teil, der Kollegen zusammenbringt — zwei Leute, die
unabhaengig voneinander an derselben Firma arbeiten, erfahren sonst
nie voneinander.

### 10.1 Was gezeigt wird

Je Firma eine Zahl: **wie viele Mitglieder** der Organisation diese Firma
derzeit warm haben (Naehe ≥ 6). Mehr nicht.

- In der Firmenansicht ein Hinweis: "Bei 3 Kolleginnen und Kollegen
  gerade Thema."
- Eine Seite "Gerade Thema" mit den Firmen der Organisation, nach dieser
  Zahl sortiert, dann nach Aktualitaet.

**Ohne Namen.** Die Zahl beantwortet "woran arbeitet mein Team gerade?",
und das ist die nuetzliche Frage. "Wer genau?" waere etwas anderes: eine
Auswertung einzelner Mitarbeiter durch ihre Kollegen, und es wuerde die
Zusage aus 9.3.1 aufgeben, die den Standardzustand traegt. Wer wissen
will, wer dranhaengt, fragt im Team — und erfaehrt es dann von einem
Menschen, der zustimmt.

Falls du Namen doch willst, ist das eine bewusste Entscheidung mit
eigener Folge (dann braucht jedes Mitglied eine eigene Zustimmung dafuer,
und die Betriebsvereinbarung sieht anders aus). Sag Bescheid, dann baue
ich es als zusaetzlichen, getrennt schaltbaren Schritt.

### 10.2 Schutz vor Rueckschluss

Eine Zahl kann verraten, wer gemeint ist. In einer Organisation mit zwei
Mitgliedern heisst "bei 1 Kollegen Thema" genau eine Person. Deshalb:

- Die Zahl erscheint erst **ab 2 Mitgliedern** mit warmem Wert.
- Und nur in Organisationen mit **mindestens 3 Mitgliedern**. Darunter
  gibt es das Aggregat nicht, auch nicht als "0".
- Keine Zeitreihe, kein Verlauf ("letzte Woche waren es 5"). Aus einem
  Verlauf lassen sich Einzelne herausrechnen.

### 10.3 Technik

Kein neuer Speicher noetig — `RelevanzWert` hat den Index
`[tenantId, actorId, rang]`, gezaehlt wird ueber `tenantId`:

```
GET /v1/relevanz/thema?limit=50
  → [{ companyId, anzahl, zuletzt }]
```

Die Route zaehlt `DISTINCT actorId` je `zielId` mit `naehe >= 6` und
liefert Zeilen erst ab `anzahl >= 2`. Der eigene Beitrag ist
mitgezaehlt — sonst waere er durch Differenzbildung sichtbar.

Gesteuert ueber ein eigenes Feld in `OrgPolicy`:

```ts
/** Duerfen Mitglieder sehen, wie viele Kolleginnen und Kollegen eine
 *  Firma gerade warm haben? true (Standard) = ja, als blosse Anzahl
 *  ohne Namen. false = die Seite "Gerade Thema" und der Hinweis in der
 *  Firmenansicht entfallen vollstaendig. */
relevanzThemaSichtbar?: boolean;
```

Schaltet die Organisation `relevanz` ganz ab, entfaellt das Aggregat
ohnehin — ohne Werte gibt es nichts zu zaehlen.

**Sichtbarkeit der Navigation:** Der Eintrag "Gerade Thema" erscheint,
wenn die Funktion erlaubt UND `relevanzThemaSichtbar` gesetzt ist — beides
sind Setzungen der Organisation, und Abgeschaltetes wird ausgeblendet,
nicht ausgegraut. Dass die Uebersicht erst ab drei Mitgliedern etwas
zeigt, erklaert dagegen die Seite selbst: Das ist ein voruebergehender
Zustand und kein Verbot, und der Eintrag soll auftauchen, sobald ein
Dritter dazukommt — nicht erst, wenn jemand ihn vermisst.

### 10.4 Was sich dadurch in Abschnitt 9 aendert

Die frueher pauschale Sperre "keine Auswertung ueber Nutzer hinweg"
(9.3.2) wird praeziser gefasst: **Aggregate ohne Personenbezug ja,
personenbezogene Auswertung nein.** Die Grenze verlaeuft nicht zwischen
"eine Zahl" und "keine Zahl", sondern dort, wo sich aus einer Zahl eine
Person ableiten laesst — genau das regeln die Schranken in 10.2. Der
Abschnitt 9.3 ist entsprechend angepasst.

---

## 11. Chat-Tool (Pflicht)

Nach der bestehenden Regel braucht jede neue Einstellung auch ein
Agent-Tool:

- `relevanz_status` — Naehe und Gewicht einer Firma/Person mit Begruendung.
- `relevanz_liste` — die naechsten Beobachtungsziele mit Rang (das ist
  keine Bestenliste ueber Nutzer, sondern die Arbeitsvorschau des
  Heartbeats).
- `relevanz_vergessen` — Signale eines Ziels loeschen (`confirmAction`).
- `relevanz_einstellen` — ein/aus, Schwellen (`confirmAction`). Bei
  bindender Setzung der Organisation lehnt das Tool mit Begruendung ab,
  statt still nichts zu tun.

Dazu ein Eintrag in der Faehigkeitsgruppen-Pflege der Chat-Vorschlaege.
Alle vier Tools sind an `ORG_FEATURES.relevanz` gebunden: abgeschaltet
heisst nicht registriert, nicht im Prompt erwaehnt, nicht vorgeschlagen.

---

## 12. Umsetzungsstufen

| Stufe | Inhalt | Ergebnis |
| --- | --- | --- |
| **R0** | Gateway: Prisma-Modelle + Migration, die fuenf Routen aus 4.2, Tilgungslauf. Desktop: Warteschlange und Buendel-Versand (4.3), Schalter, `ORG_FEATURES`-Schluessel `relevanz` + `relevanzSelbstbestimmt`, Erst-Hinweis. Noch ohne Wirkung. | Erfassung laeuft, nichts aendert sich sichtbar |
| **R1** | Vorhandene Signale anschliessen: Detailansicht, Chat-Link, Uebernehmen, Import, Workflow, Watchlist. `InterestStore` liest neu, schreibt nicht mehr selbst. | Erste echte Werte |
| **R2** | Gewicht aus ICP/Status/Pipeline lokal bilden und mitschicken; Rang im Gateway; Anzeige in der Firmenansicht mit Begruendung. | Nutzer sieht und versteht den Wert |
| **R3** | Heartbeat-Priorisierung inklusive Entdeckungsspur und Alterung. | Beobachtung folgt dem Rang |
| **R4** | Personensignale: Profilklick, DSGVO-Hinweis, CRM, E-Mail, Kontaktsuche. Vererbung von der Firma. | Personen werden unterscheidbar |
| **R5** | Hochstufung bei heissen Firmen, Tageszusammenfassung fuer das gesammelte Rauschen. Nichts wird unterdrueckt. | Der Positionswechsel-Fall ist geloest |
| **R6** | Chat-Tools, Einsicht und Export in den Einstellungen, punktuelles Vergessen, Tilgung beim Ausscheiden aus der Organisation. | Vollstaendig bedienbar |
| **R7** | Organisationsaggregat: Route `/v1/relevanz/thema`, Hinweis in der Firmenansicht, Seite "Gerade Thema", `relevanzThemaSichtbar` als Admin-Schalter. | Kollegen sehen, was Thema ist |

R0–R2 sind die Grundlage und sollten zusammen kommen. R3 und R5 tragen
den Nutzen. R4 ist der Teil, nach dem gefragt wurde, braucht aber R0–R2
darunter.

R7 braucht mehrere aktive Mitglieder, um ueberhaupt etwas zu zeigen —
es lohnt erst, wenn R0–R2 ein paar Wochen in einer echten Organisation
gelaufen sind.

**Ausserhalb der Stufen, aber vor der ersten Enterprise-Freigabe
faellig:** der Eintrag im Verarbeitungsverzeichnis und im AV-Vertrag
(9.4). Das ist keine Programmierarbeit und geraet deshalb leicht aus dem
Blick; mit der zentralen Ablage ist es aber Voraussetzung, nicht Kuer.

---

## 13. Offene Entscheidungen

1. **Gewichte und Halbwertszeiten.** Die Zahlen in Abschnitt 3 sind
   geschaetzt. Vorschlag: fest verdrahtet starten, nach vier Wochen
   anhand echter Verteilungen nachziehen. Keine Einstellmoeglichkeit fuer
   Nutzer — sonst justiert niemand, und jede Fehlersuche braucht zuerst
   eine Konfigurationsabfrage.
2. **Geraeteuebergreifend?** Entschieden: ja, durch die zentrale Ablage
   (Abschnitt 4). Bleibt zu klaeren, ob die Signale im Ruhezustand
   zusaetzlich verschluesselt werden sollen. Eine Verschluesselung mit
   Schluessel beim Nutzer waere das staerkste Versprechen, schliesst aber
   die Berechnung im Gateway (4.4) aus und faellt damit praktisch weg.
   Mein Vorschlag: Verschluesselung der Datenbank wie bei allem anderen
   auch, keine Sonderbehandlung, dafuer die Zusagen aus 9.3 hart halten.
3. ~~**Organisationsaggregat.**~~ Entschieden: wird gebaut, als
   Abschnitt 10. Anzahl ohne Namen, erst ab 2 warmen Mitgliedern und nur
   in Organisationen ab 3 Mitgliedern, kein Verlauf. Offen bleibt allein,
   ob spaeter auch **Namen** gezeigt werden sollen — das waere eine
   eigene Entscheidung mit eigener Zustimmung je Mitglied (10.1).
4. **Saettigung bei 30 und Wiederkehr-Bonus +4 je Tag (Deckel +20).**
   Damit landen drei Aufrufe an drei Tagen bei 8,6 (5.1). Die Zahlen sind
   auf genau dieses Gefuehl hin gewaehlt und nach den ersten Wochen an
   der tatsaechlichen Verteilung zu pruefen.
5. ~~**Alarm weggewischt = negativ.**~~ Entschieden: Wegwischen zaehlt,
   aber **erst ab dem dritten Mal** derselben Alarmart bei derselben
   Firma. Einmal wegwischen heisst meist "gesehen, erledigt"; dreimal
   dieselbe Art wegwischen heisst "damit will ich nicht behelligt
   werden". Der Malus von -3 faellt also nur auf das dritte und jedes
   weitere Wegwischen an. Im Signalkatalog (3.1) entsprechend vermerkt.
6. **Entdeckungsspur ein Viertel.** Der Anteil bestimmt, wie stark AVA
   ueber den Tellerrand sieht. Zu klein und sie ist wirkungslos; zu gross
   und der Heartbeat vernachlaessigt das Wichtige.
7. ~~**Freitext-Erkennung von Firmennamen im Chat.**~~ Entschieden:
   nicht noetig. Erfasst wird die `companyId` aus Werkzeugaufrufen und
   aus Suchergebnissen mit wenigen Treffern (3.4). Nennt der Nutzer eine
   Firma, sucht der Agent sie ohnehin — die ID liegt also vor, und nur
   ueber sie laesst sich ein Wert verknuepfen.

---

## 14. Was wir bewusst nicht bauen

- **Keine Champions.** Das Nachverfolgen von Firmenwechseln bekannter
  Kontakte ist eine eigene Funktion mit eigenem Nutzen; sie gehoert nicht
  in einen Aufmerksamkeitswert. (Eigener Plan, falls gewuenscht.)
- **Keine Vorhersage.** Der Score sagt, was war, nicht was kommt. "Diese
  Firma wird bald kaufen" braucht Abschlussdaten, die AVA nicht hat, und
  waere ohne sie geraten.
- **Keine Rangliste von Mitarbeitern.** Das Aggregat aus Abschnitt 10
  zaehlt Firmen, nicht Menschen. Eine Ansicht, die Mitglieder nach
  Aktivitaet sortiert, waere das Gegenteil davon.
- **Keine Weitergabe an Dritte und keine Telemetrie**, auch nicht
  "anonym zur Verbesserung". Die Signale dienen dem einen Zweck, fuer
  den sie erhoben werden.
- **Kein Einblick fuer Administratoren.** Die Versuchung ist mit der
  zentralen Ablage groesser geworden, die Antwort bleibt dieselbe. Diese
  Zusage traegt den Standardzustand "an"; sie aufzuweichen hiesse, ihn
  neu zu verhandeln.
