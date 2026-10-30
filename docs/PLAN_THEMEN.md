# Plan: Themen — wonach der Website-Producer zusätzlich sucht

Stand 2026-10-30. Anlass: Joyce, Münstermann GmbH. „Betriebliche Altersvorsorge“
steht auf der Karriereseite, nicht in den Anzeigen. Der Karriere-Durchgang
(docs/PLAN_STELLEN_SIGNALE.md) findet genau das heute schon, aber nur als fest
verdrahteten Sonderfall „Arbeitgeberleistungen“. Versicherer wollen Altersvorsorge,
ein Energieberater Photovoltaik und Fuhrpark, ein Zertifizierer ISO-Normen. Das
lässt sich nicht vorab bauen. Deshalb: Themen als Einstellung des Nutzers, die der
Website-Producer bei jedem Lauf gezielt prüft, mit Zitat und Quelle je Fund — und
die dem Nutzer überall begegnen, damit er weiß, dass er sie pflegen kann.

## 1. Zielbild

- Der Nutzer legt bis zu fünf **Themen** an: Name, kurze Beschreibung, warum es ihn
  interessiert, Suchbegriffe. AVA ergänzt Begriffe und Synonyme (deutsch und
  englisch) und zeigt sie, der Nutzer kann sie ändern.
- Der Website-Producer prüft je Firma und Thema in drei Stufen über den vorhandenen
  Walker (docs/PLAN_WEBSITE_WALKER.md): Seitenwahl aus dem Linkgraphen, Fundstellen
  per Begriffssuche in den Blöcken, Urteil mit wörtlichem Zitat. Ohne Zitat kein
  Fund.
- Ergebnis je Firma und Thema: `gefunden`, `nicht gefunden`, `unklar`, mit Zitat,
  Seite, Überschriftenpfad und Datum. Gespeichert in der Website-DB, sichtbar im
  Desktop, in app.ava.bi, im Chat, als Filter und als Alarm.
- Themen sind **omnipräsent**: Chip auf der Chat-Startseite, Abschnitt in den
  Einstellungen, Chat-Werkzeuge mit Bestätigung, Hinweis in den Firmendetails,
  Vorschlag direkt nach dem ICP.
- Läuft auf dem allgemeinen Producer-Modell des Nutzers (kein Recherche-Schlüssel,
  keine Websuche), Kosten je Firma und Thema: ein kleiner Aufruf für die Seitenwahl,
  einer für das Urteil.

## 1a. Benennung (Joyce, 2026-10-30)

Nutzersichtbar heißen die Themen **„Fokus-Themen“** (Einstellungen, Chip, Werkzeuge,
Recherche-Zeile) und der Reiter in den Firmendetails **„Mein Fokus“**: Der Nutzer soll
sofort sehen, dass hier steht, was ihn persönlich interessiert. Im Code und in diesem
Plan bleibt `themen`. Der Reiter „Kunden“ heißt jetzt „Referenzen & Partner“, weil er
auch Partner, Technologiepartner, Zertifikate und genutzte Werkzeuge zeigt.

## 2. Datenmodell

**Thema** (lokal, `userData/themen/themen.json`, Store `ThemenStore` nach dem Muster
`main/suggestions/settings.ts`):

| Feld | Inhalt |
|---|---|
| id | Kurz-ID |
| schluessel | Slug aus dem Namen (`betriebliche-altersvorsorge`), stabil, Schlüssel in der Website-DB |
| name | „Betriebliche Altersvorsorge“ |
| beschreibung | was gemeint ist, ein Satz |
| warum | wozu der Nutzer es braucht (fließt in das Urteil ein) |
| begriffe | Suchbegriffe, vom Nutzer plus von AVA ergänzt; je Begriff `quelle: nutzer | ava` |
| aktiv | an/aus |
| quelle | `nutzer`, `icp` (aus dem ICP vorgeschlagen), `organisation` (später) |
| updatedAt | |

Das Nutzerprofil hat bereits `topics` („Geschäftsführer-Wechsel“, „M&A“) für
Nachrichtenthemen; das bleibt getrennt. Nutzersichtbar heißt das Neue
„Website-Themen“, Anker `themen-section`.

**Themenbefund** (Website-DB, Tabelle `CompanyThema`, Schema über `ensureStellenSchema`
im Gateway wie `CompanyKarriere`):

| Spalte | Inhalt |
|---|---|
| companyId, schluessel | Schlüssel |
| name | Themenname zum Zeitpunkt des Laufs |
| status | `gefunden` / `nicht_gefunden` / `unklar` |
| zitat | wörtliche Passage, max. 400 Zeichen |
| quelleUrl, ueberschrift | Seite und Überschriftenpfad der Fundstelle |
| begruendung | ein Satz des Modells |
| erstgesehenAt, updatedAt | Erstsichtung bleibt beim Ersetzen erhalten (für den Alarm) |

Mehrere Nutzer einer Organisation teilen die Website-DB; der Befund hängt am
`schluessel`, nicht an der lokalen Thema-ID. Gleicher Name = gleicher Befund.

## 3. Verarbeitung im Website-Producer

Übergabe: `AVA_THEMEN_CONFIG=<Pfad>` wie `AVA_EMAIL_MUSTER_CONFIG`; der Producer liest
die Datei je Lauf neu, kein Neustart bei Änderung. Themen laufen nach den Stellen
im normalen Lauf (`compute-worker.ts`) und als manueller Lauf je Firma
(`#research:themen=standard`). Ergebnis geht im `tenant.persist.website-research.v1`
als `themen[]` mit (Semantik wie Stellen: Liste vorhanden = gelaufen).

| Stufe | Was | Budget |
|---|---|---|
| T-a Seitenwahl | Linkgraph der Firma (`graph.ts`, bis 500 URLs). Ein Modellaufruf bekommt Pfade plus Linktexte und die Themen (Name, Beschreibung) und wählt je Thema bis 5 Seiten. Deterministische Vorauswahl davor: Pfade mit Begriffstreffer sind gesetzt, `impressum`, `datenschutz`, `kontakt`, `login` nie. | 1 Aufruf je Firma, nur Pfade |
| T-b Fundstellen | Gewählte Seiten in Blöcke (`bloecke.ts`). Begriffssuche je Block: Groß/Klein egal, Wortstämme (`altersvorsorg`, `pension`), Synonyme aus `begriffe`. Treffer-Block plus Nachbarblock, je Thema bis 8 Blöcke, 12.000 Zeichen. Kein Modell. | 0 Aufrufe |
| T-c Urteil | Ein Aufruf je Firma mit allen Themen und ihren Blöcken: Status, Zitat (muss wörtlich in einem Block vorkommen, sonst `unklar`), Fundstelle, Begründung. `warum` steht im Prompt, damit „wir vermitteln Altersvorsorge“ (Anbieter) von „wir bieten Altersvorsorge“ (Arbeitgeber) unterschieden wird. | 1 Aufruf je Firma |

Ohne Treffer in T-b: `nicht_gefunden` ohne Modellaufruf. Semantische Suche über
lokale Embeddings erst als T-b2, wenn die Messung (§6) zeigt, dass Umschreibungen
durchfallen.

Der heutige Karriere-Durchgang bleibt vorerst unverändert (fester Sonderfall mit
eigener Tabelle); sobald T3 misst, dass das Thema „Arbeitgeberleistungen“ über den
Themen-Weg gleich gut ist, wird er darauf umgestellt.

## 4. Überall sichtbar

| Ort | Was |
|---|---|
| Chat-Startseite | Chip „Website-Themen festlegen“ (fest und KI, `erzeugung.ts`), solange kein Thema aktiv; danach Chip „Themen prüfen“ für Firmen ohne Befund. Nutzerstand bekommt `themen: { anzahl, aktiv }` (auch in `nutzerstandText`, sonst kein Cache-Wechsel). Erledigt-Regel in `harteSchranke`. |
| Nach dem ICP | `icp_set` und die ICP-Karte schlagen zwei bis drei Themen aus Angebot und Nutzen vor („Du bietest bAV-Beratung: Thema ‚Betriebliche Altersvorsorge‘ anlegen?“), Bestätigung im Chat. |
| Einstellungen | Tab Datenquellen, Abschnitt „Website-Themen“: Liste, an/aus, Begriffe sichtbar und änderbar, „Begriffe ergänzen lassen“, Suche im Einstellungsindex. |
| Chat-Werkzeuge | `themen_get`, `themen_set` (anlegen/ändern/löschen mit Bestätigung), `themen_begriffe` (Synonyme vorschlagen); Befund je Firma über `company_get` Bereich `themen`; Lauf über `research_run` mit `feature: "themen"`. Fähigkeitsgruppe `themen`. |
| Firmendetails Desktop | Reiter „Themen“: je Thema Status, Zitat, Quelle als Link, Datum; Leerzustand mit Knopf „Themen prüfen“; Zeile im Recherche-Bereich (`RechercheLauf.tsx`). Ohne angelegte Themen ein Hinweis mit Link zu den Einstellungen. |
| app.ava.bi | Bereich „Themen“ auf der Firmenseite, gleiche Karten. |
| Firmenliste | Filter „Thema gefunden: …“ (Gateway `/v1/companies/matrix` Parameter `thema`). |
| Meldungen | Alarm `thema.gefunden`, wenn ein Thema bei einer Firma neu `gefunden` ist (Erstsichtung), mit Zitat und Quelle (docs/PLAN_AUFFRISCHUNG, Neuheiten). |

## 5. Stufen

| Stufe | Inhalt | Stand |
|---|---|---|
| T0 | Plan, Messgrößen | 2026-10-30 |
| T1 | Desktop: `ThemenStore`, IPC `themen:*`, Einstellungs-Abschnitt, Werkzeuge `themen_*`, Fähigkeitsgruppe, Nutzerstand + Chip, Vorschlag nach dem ICP, Datei an den Producer | v0.1.892 (2026-10-30) |
| T2 | Producer: `walker/themen.ts` (T-a bis T-c), Einbau in Normal- und Manuell-Lauf, `themen[]` im Research-Persist; Gateway: `CompanyThema`, Persist, `/website` liefert `themen`; Recherche-Zeile „Themen prüfen“ und `research_run feature=themen` | v0.1.892 (2026-10-30), Gateway-Deploy offen |
| T3 | Messung an zehn Firmen mit drei Themen (§6), Nachschärfen der Begriffssuche | |
| T4 | Anzeige: Reiter Desktop „Mein Fokus“ (auch vor der ersten Prüfung, mit „Jetzt prüfen“), Bereich app.ava.bi, `company_get` Bereich `fokus`, Recherche-Zeile, manueller Lauf | v0.1.893 (2026-10-30) |
| T5 | Alarm „Fokus-Thema gefunden“ (Gateway-Neuheit `thema-gefunden` aus `CompanyThema.erstgesehenAt`, Desktop-Meldung kind `fokus-thema` mit Zitat und Quelle, Judge-Regel: Anlass per Definition, standardmäßig an); Filter „Fokus-Thema gefunden“ in Meine Firmen (Desktop-Auswahl → `/v1/companies/matrix?thema=`, Gateway holt die führende Menge aus `CompanyThema`, master-data filtert per `companyIds`). Offen: Filter in app.ava.bi (die App kennt die lokalen Themen nicht; braucht einen Gateway-Endpunkt mit den gefundenen Themen je Nutzerbestand) und MCP `meine_firmen` | v0.1.894 (2026-10-30), Deploys Gateway + master-data |
| T6 | Karriere-Durchgang auf den Themen-Weg umstellen, wenn T3 es trägt | |

Reihenfolge: T1, T2 zusammen in einem Release (Producer und Desktop), T4, T3, T5, T6.

## 6. Messung

Zehn Firmen aus dem Bestand (darunter Münstermann, Strategic IT), drei Themen
(Betriebliche Altersvorsorge, ISO 27001, Nachhaltigkeit/Photovoltaik). Je Firma und
Thema von Hand: steht es auf der Website, und wo? Dann: Trefferquote von T-b
(Fundstellen gefunden), Richtigkeit von T-c (Status und Zitat), Seiten und Zeichen
je Firma, Modellaufrufe, Laufzeit. Ziel: 9 von 10 Funden mit richtigem Zitat, kein
falscher `gefunden`, unter 25.000 Zeichen je Firma und Lauf.

## 7. Entscheidungen (Joyce, 2026-10-30)

1. Themen gibt es nur je Nutzer, nicht je Organisation. Der Befund in der Website-DB ist
   trotzdem geteilt, weil er am Themenschlüssel hängt.
2. Obergrenze fest: fünf aktive Themen, unabhängig vom Plan.
3. Der Alarm „Thema neu gefunden“ ist standardmäßig an, wie die anderen Neuheiten.
